/**
 * GET  /api/meetings?projectId=xxx — list meetings for a project
 * POST /api/meetings — schedule a new review meeting (insert a meeting record
 *                      with a booking link; actual scheduling happens via Cal.com)
 *
 * Auth: company/admin role required for GET; company role required for POST.
 * Company sessions are scoped to their own company's projects.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { meetings, candidates, projects } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

async function getAuth(req: NextRequest) {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  return { session, role };
}

function rateLimited(req: NextRequest, namespace: string, max: number, windowSec: number) {
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit(namespace, ip, max, windowSec);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }
  return null;
}

// ── GET ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { session, role } = await getAuth(req);
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }
  const limited = rateLimited(req, "meetings-get", 60, 60);
  if (limited) return limited;

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId || projectId.length > 100) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  if (isDemoMode()) {
    if (session?.role === "company" && session.companyId) {
      const { getDemoTables: getTables } = await import("@/lib/demo/store");
      const demoProject = getTables().projects.find((p) => p.id === projectId);
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const rows = t.meetings
      .filter((m) => m.projectId === projectId)
      .sort((a, b) => +b.createdAt - +a.createdAt);
    const byId = Object.fromEntries(
      t.candidates
        .filter((c) => c.projectId === projectId)
        .map((c) => [c.id, { id: c.id, name: c.name, email: c.email }])
    );
    return NextResponse.json({
      meetings: rows.map((m) => ({
        id: m.id,
        candidateId: m.candidateId,
        projectId: m.projectId,
        calBookingUid: m.calBookingUid,
        scheduledAt: m.scheduledAt?.toISOString() ?? null,
        status: m.status,
        calCancelReason: m.calCancelReason,
        bookingLink: m.bookingLink,
        createdAt: m.createdAt.toISOString(),
        candidate: byId[m.candidateId] ?? null,
      })),
    });
  }

  if (session?.role === "company" && session.companyId) {
    const [project] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const rows = await db
    .select({
      id: meetings.id,
      candidateId: meetings.candidateId,
      projectId: meetings.projectId,
      calBookingUid: meetings.calBookingUid,
      scheduledAt: meetings.scheduledAt,
      status: meetings.status,
      calCancelReason: meetings.calCancelReason,
      bookingLink: meetings.bookingLink,
      createdAt: meetings.createdAt,
    })
    .from(meetings)
    .where(eq(meetings.projectId, projectId))
    .orderBy(desc(meetings.createdAt));

  // Join candidate names for display
  const candidateIds = [...new Set(rows.map((r) => r.candidateId))];
  const candidateRows =
    candidateIds.length > 0
      ? await db
          .select({ id: candidates.id, name: candidates.name, email: candidates.email })
          .from(candidates)
          .where(eq(candidates.projectId, projectId))
      : [];

  const byId = Object.fromEntries(candidateRows.map((c) => [c.id, c]));

  return NextResponse.json({
    meetings: rows.map((m) => ({
      ...m,
      scheduledAt: m.scheduledAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      candidate: byId[m.candidateId] ?? null,
    })),
  });
}

// ── POST ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { session, role } = await getAuth(req);
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }
  const limited = rateLimited(req, "meetings-create", 30, 60);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { projectId, candidateId, scheduledAt, bookingLink, title } = body as Record<string, unknown>;

  if (!projectId || typeof projectId !== "string" || projectId.length > 100) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  if (!candidateId || typeof candidateId !== "string" || candidateId.length > 100) {
    return NextResponse.json({ error: "candidateId required" }, { status: 400 });
  }
  if (typeof scheduledAt === "string" && scheduledAt.length > 64) {
    return NextResponse.json({ error: "scheduledAt too long" }, { status: 400 });
  }
  if (typeof bookingLink === "string" && bookingLink.length > 500) {
    return NextResponse.json({ error: "bookingLink too long" }, { status: 400 });
  }
  if (title !== undefined && (typeof title !== "string" || title.length > 200)) {
    return NextResponse.json({ error: "invalid title" }, { status: 400 });
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    if (session?.role === "company" && session.companyId) {
      const demoProject = t.projects.find((p) => p.id === projectId);
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
    const candidate = t.candidates.find((c) => c.id === candidateId);
    if (!candidate || candidate.projectId !== projectId) {
      return NextResponse.json({ error: "Candidate not found in this project" }, { status: 404 });
    }
    const id = `demo-meeting-${nanoid(8)}`;
    const now = new Date();
    t.meetings.push({
      id,
      candidateId,
      projectId,
      calBookingUid: null,
      scheduledAt: scheduledAt && typeof scheduledAt === "string" ? new Date(scheduledAt) : null,
      status: "scheduled",
      calCancelReason: null,
      bookingLink: typeof bookingLink === "string" ? bookingLink : null,
      createdAt: now,
      updatedAt: now,
    });
    return NextResponse.json({ ok: true, id, title: title ?? "Review Meeting", simulated: true }, { status: 201 });
  }

  if (session?.role === "company" && session.companyId) {
    const [project] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Verify candidate belongs to this project
  const [candidate] = await db
    .select({ id: candidates.id, projectId: candidates.projectId })
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);

  if (!candidate || candidate.projectId !== projectId) {
    return NextResponse.json({ error: "Candidate not found in this project" }, { status: 404 });
  }

  const id = nanoid();
  await db.insert(meetings).values({
    id,
    candidateId,
    projectId,
    scheduledAt: scheduledAt && typeof scheduledAt === "string"
      ? new Date(scheduledAt)
      : undefined,
    bookingLink: typeof bookingLink === "string" ? bookingLink : null,
    status: "scheduled",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return NextResponse.json({ ok: true, id, title: title ?? "Review Meeting" }, { status: 201 });
}
