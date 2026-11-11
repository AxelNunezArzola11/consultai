/**
 * POST /api/candidates/hire
 *
 * Hires a candidate — transitions status to "selected" (terminal).
 * Legal from "booking_unlocked" (direct hire, meeting leg skipped) and
 * "meeting_held" (canonical path), enforced by assertCandidateTransition.
 * Requires company or admin role with a verified session in live mode.
 *
 * Body: { candidateId: string, projectId: string }
 *
 * Response includes `freelancerAccountMatched`: whether a registered
 * freelancer account shares the candidate's email or GitHub handle. The
 * freelancer dashboard keys off that identity match, so a `false` here
 * tells the company the hire is recorded but the freelancer cannot see
 * the work until they register with a matching email/handle.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { candidates, projects, users } from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { eq, and, ilike } from "drizzle-orm";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import {
  companySessionAllowsLiveAccess,
  findUserByEmail,
  getSessionFromCookie,
} from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";
import {
  assertCandidateTransition,
  CandidateTransitionError,
} from "@/lib/state-machines/candidate-pipeline";

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
  const { ok, retryAfterSec } = checkRateLimit("candidate-hire", ip, 30, 60);
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
    if (candidate.status === "selected") {
      return NextResponse.json({
        ok: true,
        status: "selected",
        alreadySelected: true,
        freelancerAccountMatched: false,
        simulated: true,
      });
    }
    try {
      assertCandidateTransition(
        candidate.status as Parameters<typeof assertCandidateTransition>[0],
        "selected"
      );
    } catch (err) {
      if (err instanceof CandidateTransitionError) {
        return NextResponse.json(
          { error: "invalid_candidate_state", detail: err.message },
          { status: 422 }
        );
      }
      throw err;
    }
    const previousStatus = candidate.status;
    candidate.status = "selected";
    candidate.updatedAt = new Date();
    await writeAuditLog({
      entityType: "candidate",
      entityId: candidateId,
      event: "CANDIDATE_HIRED",
      actor: session ? `${session.role}:${session.userId}` : "company",
      payload: { projectId, previousStatus },
    });
    return NextResponse.json({
      ok: true,
      status: "selected",
      previousStatus,
      freelancerAccountMatched: false,
      simulated: true,
    });
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

  // Idempotent — already hired is fine (re-report the account match).
  if (candidate.status === "selected") {
    return NextResponse.json({
      ok: true,
      status: "selected",
      alreadySelected: true,
      freelancerAccountMatched: await hasMatchingFreelancerAccount(
        candidate.email,
        candidate.githubHandle
      ),
    });
  }

  try {
    assertCandidateTransition(
      candidate.status as Parameters<typeof assertCandidateTransition>[0],
      "selected"
    );
  } catch (err) {
    if (err instanceof CandidateTransitionError) {
      return NextResponse.json(
        { error: "invalid_candidate_state", detail: err.message },
        { status: 422 }
      );
    }
    throw err;
  }

  await db
    .update(candidates)
    .set({ status: "selected", updatedAt: new Date() })
    .where(eq(candidates.id, candidateId));

  await writeAuditLog({
    entityType: "candidate",
    entityId: candidateId,
    event: "CANDIDATE_HIRED",
    actor: session ? `${session.role}:${session.userId}` : "company",
    payload: { projectId, previousStatus: candidate.status },
  });

  return NextResponse.json({
    ok: true,
    status: "selected",
    previousStatus: candidate.status,
    freelancerAccountMatched: await hasMatchingFreelancerAccount(
      candidate.email,
      candidate.githubHandle
    ),
  });
}

/**
 * True when a registered freelancer account shares the candidate's email
 * or GitHub handle — i.e. the hire is visible on a freelancer dashboard.
 * Email resolves through the auth store (memory seeds + DB); handle
 * resolves through the users table in live mode only.
 */
async function hasMatchingFreelancerAccount(
  email: string,
  githubHandle: string | null
): Promise<boolean> {
  const byEmail = await findUserByEmail(email).catch(() => null);
  if (byEmail?.role === "freelancer") return true;
  const handle = githubHandle?.trim().toLowerCase();
  if (!handle || isDemoMode() || !process.env.DATABASE_URL) return false;
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(ilike(users.githubHandle, handle), eq(users.role, "freelancer")))
      .limit(1);
    return rows.length > 0;
  } catch {
    // Account matching is informational — never fail the hire on it.
    return false;
  }
}
