/**
 * DELETE /api/projects/[id]
 *
 * Deletes a project and all its dependent records in topological order
 * (leaves first) inside a single transaction, to avoid FK violations.
 *
 * Auth: requires company role cookie.
 * Returns 200 { ok: true } on success, 404 if not found, 403 if unauthorized.
 *
 * Deletion order (all within one transaction):
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
  // Auth check — only company role can delete projects
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: projectId } = await params;

  // Verify the project exists before attempting deletion
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // ── Cascade delete inside a single transaction ────────────────────────────
  await db.transaction(async (tx) => {
    // 1. Collect milestone IDs for this project
    const milestoneRows = await tx
      .select({ id: milestones.id })
      .from(milestones)
      .where(eq(milestones.projectId, projectId));
    const milestoneIds = milestoneRows.map((m) => m.id);

    // 2. Collect candidate IDs for this project
    const candidateRows = await tx
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.projectId, projectId));
    const candidateIds = candidateRows.map((c) => c.id);

    // 3. Collect verification run IDs for these milestones
    let runIds: string[] = [];
    if (milestoneIds.length > 0) {
      const runRows = await tx
        .select({ id: verificationRuns.id })
        .from(verificationRuns)
        .where(inArray(verificationRuns.milestoneId, milestoneIds));
      runIds = runRows.map((r) => r.id);
    }

    // 4. Collect payment IDs for these milestones
    let paymentIds: string[] = [];
    if (milestoneIds.length > 0) {
      const paymentRows = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(inArray(payments.milestoneId, milestoneIds));
      paymentIds = paymentRows.map((p) => p.id);
    }

    // ── Delete leaves first ──────────────────────────────────────────────

    // agent_steps (FK → verification_runs.id)
    if (runIds.length > 0) {
      await tx.delete(agentSteps).where(inArray(agentSteps.runId, runIds));
    }

    // payment_proposals (FK → milestones.id + verification_runs.id)
    if (milestoneIds.length > 0) {
      await tx
        .delete(paymentProposals)
        .where(inArray(paymentProposals.milestoneId, milestoneIds));
    }

    // approvals (FK → payments.id + milestones.id)
    if (paymentIds.length > 0) {
      await tx.delete(approvals).where(inArray(approvals.paymentId, paymentIds));
    }

    // disputes (FK → milestones.id)
    if (milestoneIds.length > 0) {
      await tx.delete(disputes).where(inArray(disputes.milestoneId, milestoneIds));
    }

    // payments (FK → milestones.id)
    if (milestoneIds.length > 0) {
      await tx.delete(payments).where(inArray(payments.milestoneId, milestoneIds));
    }

    // verification_runs (FK → milestones.id)
    if (milestoneIds.length > 0) {
      await tx
        .delete(verificationRuns)
        .where(inArray(verificationRuns.milestoneId, milestoneIds));
    }

    // signals (FK → candidates.id)
    if (candidateIds.length > 0) {
      await tx.delete(signals).where(inArray(signals.candidateId, candidateIds));
    }

    // evidence (FK → candidates.id)
    if (candidateIds.length > 0) {
      await tx.delete(evidence).where(inArray(evidence.candidateId, candidateIds));
    }

    // cascade_log (FK → projects.id + candidates.id)
    await tx.delete(cascadeLog).where(eq(cascadeLog.projectId, projectId));

    // ndas (FK → candidates.id + projects.id)
    await tx.delete(ndas).where(eq(ndas.projectId, projectId));

    // meetings (FK → candidates.id + projects.id)
    await tx.delete(meetings).where(eq(meetings.projectId, projectId));

    // milestones (FK → projects.id)
    await tx.delete(milestones).where(eq(milestones.projectId, projectId));

    // candidates (FK → projects.id)
    await tx.delete(candidates).where(eq(candidates.projectId, projectId));

    // brief_drafts (FK → projects.id)
    await tx.delete(briefDrafts).where(eq(briefDrafts.projectId, projectId));

    // projects (root)
    await tx.delete(projects).where(eq(projects.id, projectId));
  });

  return NextResponse.json({ ok: true });
}
