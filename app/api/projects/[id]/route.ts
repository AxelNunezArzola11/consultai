/**
 * PATCH /api/projects/[id]
 *
 * Partially updates a project's mutable fields.
 * Currently supported fields:
 *   - githubRepoUrl (string | null)
 *
 * Auth: requires company/admin role; company sessions are scoped to their own projects.
 * Returns 200 { ok: true } on success, 404 if not found, 403 if unauthorized.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DELETE /api/projects/[id]
 *
 * Deletes a project and all its dependent records in topological order
 * (leaves first) to avoid FK constraint violations.
 *
 * IMPORTANT: neon-http driver does NOT support transactions
 * (throws "No transactions support in neon-http driver").
 * Deletes are done sequentially, leaves-first, so any partial failure
 * is safe to retry — later deletes always succeed once earlier ones pass.
 *
 * Auth: requires company/admin role; company sessions are scoped to their own projects.
 * Returns 200 { ok: true } on success, 404 if not found, 403 if unauthorized.
 *
 * Deletion order:
 *   agent_steps → payment_proposals → approvals → disputes → payments
 *   → verification_runs → signals → evidence → cascade_log → ndas
 *   → meetings → milestones → candidates → brief_drafts → projects
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  projects,
  milestones,
  candidates,
  evidence,
  ndas,
  meetings,
  payments,
  approvals,
  disputes,
  verificationRuns,
  agentSteps,
  paymentProposals,
  briefDrafts,
  signals,
  cascadeLog,
} from "@/lib/db/schema";
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

// ---------------------------------------------------------------------------
// PATCH — update mutable project fields (e.g. githubRepoUrl)
// ---------------------------------------------------------------------------

const GITHUB_REPO_URL_PATTERN = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { session, role } = await getAuth(req);
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const { id: projectId } = await params;
  if (projectId.length > 100) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }

  let body: { githubRepoUrl?: string | null; projectTitle?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate the repo URL when provided
  if (body.githubRepoUrl != null) {
    if (typeof body.githubRepoUrl !== "string") {
      return NextResponse.json({ error: "githubRepoUrl must be a string or null" }, { status: 400 });
    }
    if (!GITHUB_REPO_URL_PATTERN.test(body.githubRepoUrl)) {
      return NextResponse.json(
        { error: "githubRepoUrl must be a valid GitHub repository URL (https://github.com/owner/repo)" },
        { status: 400 }
      );
    }
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const {
      demoCompanyForSession,
      resolveDemoDraftForPlanning,
    } = await import("@/lib/demo/drafts");
    let project = getDemoTables().projects.find((p) => p.id === projectId);
    // Serverless-safe: a cold instance rehydrates the POST-accepted draft
    // from the creation title; bare IDs still 404 honestly.
    if (!project) {
      const rehydrated = resolveDemoDraftForPlanning({
        projectId,
        title: body.projectTitle,
        companyId: demoCompanyForSession(session?.companyId),
      });
      if (rehydrated) {
        project = getDemoTables().projects.find((p) => p.id === projectId);
      }
    }
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId &&
        project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    project.githubRepoUrl = body.githubRepoUrl ?? null;
    project.updatedAt = new Date();
    return NextResponse.json({ ok: true, simulated: true });
  }

  try {
    const [existing] = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId &&
        existing.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    await db
      .update(projects)
      .set({ githubRepoUrl: body.githubRepoUrl ?? null, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE — cascade-delete the project and all dependent records
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // Auth check — only company/admin roles can delete projects
  const { session, role } = await getAuth(req);
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const deleteIp = getIp(req);
  const deleteLimit = checkRateLimit("project-delete", deleteIp, 10, 300);
  if (!deleteLimit.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(deleteLimit.retryAfterSec) } }
    );
  }

  const { id: projectId } = await params;

  if (isDemoMode()) {
    const { getDemoTables, appendDemoAudit } = await import("@/lib/demo/store");
    const { DEMO_IDS } = await import("@/lib/demo/config");
    if (projectId === DEMO_IDS.project) {
      return NextResponse.json(
        { error: "The canonical TechNova demo project cannot be deleted. Use Demo Reset to restore fixtures." },
        { status: 409 }
      );
    }
    const t = getDemoTables();
    const idx = t.projects.findIndex((p) => p.id === projectId);
    if (idx < 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId &&
        t.projects[idx].companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    t.projects.splice(idx, 1);
    t.milestones = t.milestones.filter((m) => m.projectId !== projectId);
    t.candidates = t.candidates.filter((c) => c.projectId !== projectId);
    t.ndas = t.ndas.filter((n) => n.projectId !== projectId);
    t.meetings = t.meetings.filter((m) => m.projectId !== projectId);
    t.schedulingProposals = t.schedulingProposals.filter((s) => s.projectId !== projectId);
    appendDemoAudit({
      entityType: "project",
      entityId: projectId,
      event: "PROJECT_DELETED",
      actor: "company-operator",
      payload: {},
    });
    return NextResponse.json({ ok: true, simulated: true });
  }

  try {
    // Verify the project exists before attempting deletion
    const [existing] = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId &&
        existing.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // ── Collect IDs needed for child-table deletes ─────────────────────────

    const milestoneRows = await db
      .select({ id: milestones.id })
      .from(milestones)
      .where(eq(milestones.projectId, projectId));
    const milestoneIds = milestoneRows.map((m) => m.id);
    console.log("[delete-project] milestones:", milestoneIds.length);

    const candidateRows = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.projectId, projectId));
    const candidateIds = candidateRows.map((c) => c.id);
    console.log("[delete-project] candidates:", candidateIds.length);

    let runIds: string[] = [];
    if (milestoneIds.length > 0) {
      const runRows = await db
        .select({ id: verificationRuns.id })
        .from(verificationRuns)
        .where(inArray(verificationRuns.milestoneId, milestoneIds));
      runIds = runRows.map((r) => r.id);
    }

    let paymentIds: string[] = [];
    if (milestoneIds.length > 0) {
      const paymentRows = await db
        .select({ id: payments.id })
        .from(payments)
        .where(inArray(payments.milestoneId, milestoneIds));
      paymentIds = paymentRows.map((p) => p.id);
    }

    // ── Delete leaves first (sequential, no transaction — neon-http limitation)

    // agent_steps (FK → verification_runs.id)
    if (runIds.length > 0) {
      await db.delete(agentSteps).where(inArray(agentSteps.runId, runIds));
    }

    // payment_proposals (FK → milestones.id)
    if (milestoneIds.length > 0) {
      await db
        .delete(paymentProposals)
        .where(inArray(paymentProposals.milestoneId, milestoneIds));
    }

    // approvals (FK → payments.id)
    if (paymentIds.length > 0) {
      await db.delete(approvals).where(inArray(approvals.paymentId, paymentIds));
    }

    // disputes (FK → milestones.id)
    if (milestoneIds.length > 0) {
      await db.delete(disputes).where(inArray(disputes.milestoneId, milestoneIds));
    }

    // payments (FK → milestones.id)
    if (milestoneIds.length > 0) {
      await db.delete(payments).where(inArray(payments.milestoneId, milestoneIds));
    }

    // verification_runs (FK → milestones.id)
    if (milestoneIds.length > 0) {
      await db
        .delete(verificationRuns)
        .where(inArray(verificationRuns.milestoneId, milestoneIds));
    }

    // signals (FK → candidates.id)
    if (candidateIds.length > 0) {
      await db.delete(signals).where(inArray(signals.candidateId, candidateIds));
    }

    // evidence (FK → candidates.id)
    if (candidateIds.length > 0) {
      await db.delete(evidence).where(inArray(evidence.candidateId, candidateIds));
    }

    // cascade_log (FK → projects.id + candidates.id)
    await db.delete(cascadeLog).where(eq(cascadeLog.projectId, projectId));

    // ndas (FK → candidates.id + projects.id)
    await db.delete(ndas).where(eq(ndas.projectId, projectId));

    // meetings (FK → candidates.id + projects.id)
    await db.delete(meetings).where(eq(meetings.projectId, projectId));

    // milestones (FK → projects.id)
    await db.delete(milestones).where(eq(milestones.projectId, projectId));

    // candidates (FK → projects.id)
    await db.delete(candidates).where(eq(candidates.projectId, projectId));

    // brief_drafts (FK → projects.id)
    await db.delete(briefDrafts).where(eq(briefDrafts.projectId, projectId));

    // projects (root)
    await db.delete(projects).where(eq(projects.id, projectId));

    console.log("[delete-project] done — project deleted:", projectId);
    return NextResponse.json({ ok: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause
      ? String((err.cause as Error).message ?? err.cause)
      : undefined;
    console.error("[delete-project] ERROR:", { message, cause, projectId });
    return NextResponse.json(
      { error: "Internal server error", detail: message, cause },
      { status: 500 }
    );
  }
}
