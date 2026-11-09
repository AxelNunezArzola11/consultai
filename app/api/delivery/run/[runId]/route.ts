/**
 * GET /api/delivery/run/[runId]
 *
 * Returns the full verification run with its agent steps and payment proposal.
 * Used by the UI to poll for status (every 2–3 s during an active run).
 *
 * Auth: any valid role (both company and freelancer can view). Live mode
 * requires a verified session: company sessions are project-scoped (D.3)
 * and freelancer sessions are assignment-scoped by session email and/or
 * GitHub handle, with missing identity failing closed (D.2).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { verificationRuns, agentSteps, paymentProposals, milestones, projects, candidates } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

type DemoTables = {
  projects: Array<{ id: string; companyId: string }>;
  milestones: Array<{ id: string; projectId: string }>;
  candidates: Array<{ projectId: string; githubHandle: string | null }>;
};

function checkDemoOwnership(
  t: DemoTables,
  session: { role: string; companyId: string | null; githubHandle: string | null } | null,
  milestoneId: string
): NextResponse | null {
  if (session?.role === "company" && session.companyId) {
    const milestone = t.milestones.find((m) => m.id === milestoneId);
    const project = milestone ? t.projects.find((p) => p.id === milestone.projectId) : undefined;
    if (!project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }
  if (session?.role === "freelancer" && session.githubHandle) {
    const milestone = t.milestones.find((m) => m.id === milestoneId);
    const handle = session.githubHandle.toLowerCase();
    const assigned =
      milestone !== undefined &&
      t.candidates.some(
        (c) =>
          c.projectId === milestone.projectId &&
          (c.githubHandle ?? "").toLowerCase() === handle
      );
    if (!assigned) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<NextResponse> {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (!role) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access); freelancer callers need a
  // verified session carrying identity (D.2 — missing email/GitHub
  // identity must not silently bypass assignment verification).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }
  if (role === "freelancer" && !isDemoMode()) {
    const gateEmail =
      session?.role === "freelancer" ? session.email.trim().toLowerCase() : "";
    const gateHandle =
      session?.role === "freelancer"
        ? (session.githubHandle ?? "").trim().toLowerCase()
        : "";
    if (!gateEmail && !gateHandle) {
      return NextResponse.json({ error: "missing_freelancer_identity" }, { status: 403 });
    }
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("delivery-run", ip, 120, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  const { runId } = await params;
  if (!runId || runId.length > 100) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const run = t.verificationRuns.find((r) => r.id === runId);
    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    const forbidden = checkDemoOwnership(t, session, run.milestoneId);
    if (forbidden) return forbidden;
    return NextResponse.json({
      run,
      steps: [],
      proposals: t.paymentProposals.filter((p) => p.runId === runId),
      simulated: true,
    });
  }

  const [run] = await db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.id, runId))
    .limit(1);

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  if (session?.role === "company" && session.companyId) {
    const [milestone] = await db
      .select({ projectId: milestones.projectId })
      .from(milestones)
      .where(eq(milestones.id, run.milestoneId))
      .limit(1);
    const [project] = milestone
      ? await db
          .select({ companyId: projects.companyId })
          .from(projects)
          .where(eq(projects.id, milestone.projectId))
          .limit(1)
      : [];
    if (!milestone || !project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }
  // Live branch (demo returns earlier): the freelancer check always runs
  // — the early gate guarantees a session with identity. Identity resolves
  // from the authenticated account (session email and/or GitHub handle).
  if (role === "freelancer") {
    const [milestone] = await db
      .select({ projectId: milestones.projectId })
      .from(milestones)
      .where(eq(milestones.id, run.milestoneId))
      .limit(1);
    const projectCandidates = milestone
      ? await db
          .select({ email: candidates.email, githubHandle: candidates.githubHandle })
          .from(candidates)
          .where(eq(candidates.projectId, milestone.projectId))
          .limit(200)
      : [];
    const email =
      session?.role === "freelancer" ? session.email.trim().toLowerCase() : "";
    const handle =
      session?.role === "freelancer"
        ? (session.githubHandle ?? "").trim().toLowerCase()
        : "";
    const assigned = projectCandidates.some(
      (c) =>
        (email !== "" && c.email.trim().toLowerCase() === email) ||
        (handle !== "" && (c.githubHandle ?? "").toLowerCase() === handle)
    );
    if (!milestone || !assigned) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const steps = await db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId))
    .orderBy(agentSteps.seq);

  const proposals = await db
    .select()
    .from(paymentProposals)
    .where(eq(paymentProposals.runId, runId));

  return NextResponse.json({ run, steps, proposals });
}
