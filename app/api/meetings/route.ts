/**
 * GET  /api/meetings?projectId=xxx — list meetings for a project
 * POST /api/meetings — schedule a new review meeting (insert a meeting record
 *                      with a booking link; actual scheduling happens via Cal.com)
 *
 * Auth: company role required for POST; GET is unauthenticated (single-tenant demo).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { meetings, candidates } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";

export const dynamic = "force-dynamic";

// ── GET ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
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
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { projectId, candidateId, scheduledAt, bookingLink, title } = body as Record<string, unknown>;

  if (!projectId || typeof projectId !== "string") {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  if (!candidateId || typeof candidateId !== "string") {
    return NextResponse.json({ error: "candidateId required" }, { status: 400 });
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
