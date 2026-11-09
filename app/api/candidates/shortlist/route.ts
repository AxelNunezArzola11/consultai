/**
 * POST /api/candidates/shortlist
 *
 * Shortlists a candidate — sets status to "shortlisted" and feeds the Phase 4 pipeline.
 * Requires company role cookie.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { candidates, projects } from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { eq, and } from "drizzle-orm";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";

export async function POST(request: NextRequest) {
  const cookieHeader = request.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(request);
  const { ok, retryAfterSec } = checkRateLimit("candidate-shortlist", ip, 30, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: { candidateId?: string; projectId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { candidateId, projectId } = body;
  if (!candidateId || typeof candidateId !== "string" || candidateId.length > 100 ||
      !projectId || typeof projectId !== "string" || projectId.length > 100) {
    return NextResponse.json({ error: "candidateId and projectId are required" }, { status: 400 });
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const candidate = t.candidates.find(
      (c) => c.id === candidateId && c.projectId === projectId
    );
    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId) {
      const demoProject = t.projects.find((p) => p.id === projectId);
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    if (candidate.status === "shortlisted") {
      return NextResponse.json({ ok: true, status: "shortlisted", alreadyShortlisted: true, simulated: true });
    }
    const previousStatus = candidate.status;
    candidate.status = "shortlisted";
    candidate.updatedAt = new Date();
    await writeAuditLog({
      entityType: "candidate",
      entityId: candidateId,
      event: "CANDIDATE_SHORTLISTED",
      actor: session ? `${session.role}:${session.userId}` : "company",
      payload: { projectId, previousStatus },
    });
    return NextResponse.json({ ok: true, status: "shortlisted", simulated: true });
  }

  const [candidate] = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.id, candidateId), eq(candidates.projectId, projectId)));

  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
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

  // Idempotent — already shortlisted is fine
  if (candidate.status === "shortlisted") {
    return NextResponse.json({ ok: true, status: "shortlisted", alreadyShortlisted: true });
  }

  await db
    .update(candidates)
    .set({ status: "shortlisted", updatedAt: new Date() })
    .where(eq(candidates.id, candidateId));

  await writeAuditLog({
    entityType: "candidate",
    entityId: candidateId,
    event: "CANDIDATE_SHORTLISTED",
    actor: session ? `${session.role}:${session.userId}` : "company",
    payload: { projectId, previousStatus: candidate.status },
  });

  return NextResponse.json({ ok: true, status: "shortlisted" });
}
