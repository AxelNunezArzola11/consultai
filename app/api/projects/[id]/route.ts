/**
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
 * Auth: requires company role cookie.
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

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // ── Diagnostic: log env availability on every invocation ──────────────────
  console.log("[delete-project] env check:", {
    DATABASE_URL: !!process.env.DATABASE_URL,
    ROLE_COOKIE_SECRET: !!process.env.ROLE_COOKIE_SECRET,
  });

  // Auth check — only company role can delete projects
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: projectId } = await params;
  console.log("[delete-project] projectId:", projectId);

  try {
    // Verify the project exists before attempting deletion
    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
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
