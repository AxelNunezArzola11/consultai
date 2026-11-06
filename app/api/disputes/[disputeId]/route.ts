/**
 * GET /api/disputes/[disputeId]
 *
 * Returns the full dispute row from the DB,
 * including the agent's proposal if analysis has run.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { disputes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildEvidencePacket } from "@/lib/disputes/evidence-packet";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> }
): Promise<NextResponse> {
  const { disputeId } = await params;

  if (!disputeId) {
    return NextResponse.json({ error: "missing disputeId" }, { status: 400 });
  }

  if (isDemoMode()) {
    const t = getDemoTables();
    const dispute = t.disputes.find((d) => d.id === disputeId);
    if (!dispute) {
      return NextResponse.json({ error: "dispute not found" }, { status: 404 });
    }
    // Full EvidencePacket shape (same contract as buildEvidencePacket) so the
    // DisputeView renders identically in demo mode. All content is simulated.
    const milestone = t.milestones.find((m) => m.id === dispute.milestoneId);
    const project = milestone
      ? t.projects.find((p) => p.id === milestone.projectId)
      : undefined;
    const criteria = (
      Array.isArray(project?.acceptanceCriteria) ? project.acceptanceCriteria : []
    ) as Array<{ id: string; description: string; verifiable: boolean }>;
    const run = [...t.verificationRuns]
      .filter((r) => r.milestoneId === dispute.milestoneId)
      .sort((a, b) => +b.createdAt - +a.createdAt)[0];
    const payment = t.payments.find((p) => p.milestoneId === dispute.milestoneId);
    const approval = payment
      ? t.approvals.find((a) => a.paymentId === payment.id)
      : undefined;
    const consultant = payment?.candidateId
      ? t.candidates.find((c) => c.id === payment.candidateId)
      : t.candidates.find((c) => c.projectId === project?.id);
    const criteriaResults = criteria.map((c) => {
      const stored = (Array.isArray(run?.criteriaResults) ? run!.criteriaResults : []) as Array<{
        criterionId: string;
        met: boolean | null;
        evidence: string[];
      }>;
      const match = stored.find((s) => s.criterionId === c.id);
      return {
        criterionId: c.id,
        description: c.description,
        met: match?.met ?? null,
        evidence: match?.evidence ?? [],
      };
    });
    return NextResponse.json({
      dispute,
      evidencePacket: {
        simulated: true,
        disputeRowId: dispute.id,
        paypalDisputeId: dispute.paypalDisputeId,
        disputeStatus: dispute.status,
        disputeReasonUntrusted: dispute.disputeReason,
        disputeAmountUsd: dispute.disputeAmountUsd,
        disputeLifeCycleStage: dispute.disputeLifeCycleStage,
        milestoneId: dispute.milestoneId,
        milestoneTitle: milestone?.title ?? dispute.milestoneId,
        milestoneStatus: milestone?.status ?? "unknown",
        milestonebudgetUsd: milestone?.budgetUsd ?? "0",
        projectTitle: project?.title ?? "Unknown project",
        acceptanceCriteria: criteria.map((c) => ({
          id: c.id,
          description: c.description,
          verifiable: c.verifiable ?? true,
        })),
        verificationRun: run
          ? {
              runId: run.id,
              prUrl: run.prUrl,
              headSha: run.headSha,
              prAuthor: run.prAuthor,
              prMerged: run.prMerged,
              criteriaResults,
              flags: Array.isArray(run.flags) ? run.flags : [],
              justification: run.justification,
              policyDecision: run.policyDecision,
              completedAt: run.updatedAt.toISOString(),
            }
          : null,
        approval: approval
          ? {
              approvalId: approval.id,
              decidedBy: approval.decidedBy,
              decidedAt: approval.decidedAt?.toISOString() ?? null,
              decision: approval.decision,
              notes: approval.notes,
            }
          : null,
        payout: payment
          ? {
              paymentId: payment.id,
              grossUsd: payment.grossUsd,
              feeUsd: payment.feeUsd,
              netUsd: payment.netUsd,
              payoutFeeUsd: payment.payoutFeeUsd,
              paypalCaptureId: payment.paypalCaptureId,
              status: payment.status,
            }
          : null,
        consultant: consultant
          ? { name: consultant.name, githubHandle: consultant.githubHandle }
          : null,
        deliveryAuditTrail: t.auditLog
          .filter((a) => a.entityId === dispute.milestoneId)
          .sort((a, b) => +a.createdAt - +b.createdAt)
          .map((a) => ({
            event: a.event,
            actor: a.actor,
            createdAt: a.createdAt.toISOString(),
          })),
        missingRequired: [],
        isComplete: true,
      },
    });
  }

  const rows = await db
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "dispute not found" }, { status: 404 });
  }

  const dispute = rows[0];

  // Also return the evidence packet for the UI timeline
  let evidencePacket = null;
  try {
    evidencePacket = await buildEvidencePacket(disputeId);
  } catch {
    // Non-fatal — dispute may be in an incomplete state
  }

  return NextResponse.json({ dispute, evidencePacket });
}
