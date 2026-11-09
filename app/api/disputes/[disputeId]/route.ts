/**
 * GET /api/disputes/[disputeId]
 *
 * Returns the full dispute row from the DB,
 * including the agent's proposal if analysis has run.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { disputes, milestones, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildEvidencePacket } from "@/lib/disputes/evidence-packet";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

async function requireCompanyOrAdmin(req: NextRequest) {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return { session, role, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return { session, role, error: NextResponse.json({ error: "missing_company_context" }, { status: 403 }) };
  }
  return { session, role, error: null };
}

async function isCrossCompanyDispute(
  session: { role: string; companyId: string | null } | null,
  milestoneId: string | null | undefined
): Promise<boolean> {
  if (session?.role !== "company" || !session.companyId || !milestoneId) return false;
  const [milestone] = await db
    .select({ projectId: milestones.projectId })
    .from(milestones)
    .where(eq(milestones.id, milestoneId))
    .limit(1);
  if (!milestone) return true;
  const [project] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, milestone.projectId))
    .limit(1);
  return !project || project.companyId !== session.companyId;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> }
): Promise<NextResponse> {
  const { disputeId } = await params;

  if (!disputeId) {
    return NextResponse.json({ error: "missing disputeId" }, { status: 400 });
  }

  const { session, error } = await requireCompanyOrAdmin(req);
  if (error) return error;

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("dispute-get", ip, 60, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  if (isDemoMode()) {
    const t = getDemoTables();
    const dispute = t.disputes.find((d) => d.id === disputeId);
    if (!dispute) {
      return NextResponse.json({ error: "dispute not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId) {
      const demoMilestone = t.milestones.find((m) => m.id === dispute.milestoneId);
      const demoProject = demoMilestone
        ? t.projects.find((p) => p.id === demoMilestone.projectId)
        : undefined;
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
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

  if (await isCrossCompanyDispute(session, dispute.milestoneId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Also return the evidence packet for the UI timeline
  let evidencePacket = null;
  try {
    evidencePacket = await buildEvidencePacket(disputeId);
  } catch {
    // Non-fatal — dispute may be in an incomplete state
  }

  return NextResponse.json({ dispute, evidencePacket });
}

/**
 * PATCH /api/disputes/[disputeId]
 *
 * Records a human-gated internal resolution decision without making any
 * live PayPal production money movement.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> }
): Promise<NextResponse> {
  const { disputeId } = await params;
  const { session, role, error } = await requireCompanyOrAdmin(req);
  if (error) return error;

  const patchIp = getIp(req);
  const patchLimit = checkRateLimit("dispute-patch", patchIp, 20, 60);
  if (!patchLimit.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(patchLimit.retryAfterSec) } }
    );
  }

  let body: {
    action?: "RECORD_EVIDENCE" | "RECORD_OFFER" | "RECORD_RESOLUTION";
    note?: string;
    offerAmountUsd?: string;
    outcome?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = body.action ?? "RECORD_RESOLUTION";
  if (action !== "RECORD_EVIDENCE" && action !== "RECORD_OFFER" && action !== "RECORD_RESOLUTION") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  const note = (body.note ?? "").trim().slice(0, 2000);
  if (body.offerAmountUsd !== undefined && !/^\d+(\.\d{1,2})?$/.test(body.offerAmountUsd)) {
    return NextResponse.json({ error: "invalid_offerAmountUsd" }, { status: 400 });
  }
  if (body.outcome !== undefined && (typeof body.outcome !== "string" || body.outcome.length > 120)) {
    return NextResponse.json({ error: "invalid_outcome" }, { status: 400 });
  }

  if (isDemoMode()) {
    const t = getDemoTables();
    const dispute = t.disputes.find((d) => d.id === disputeId);
    if (!dispute) {
      return NextResponse.json({ error: "dispute not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId) {
      const demoMilestone = t.milestones.find((m) => m.id === dispute.milestoneId);
      const demoProject = demoMilestone
        ? t.projects.find((p) => p.id === demoMilestone.projectId)
        : undefined;
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    const now = new Date();
    if (action === "RECORD_EVIDENCE") {
      dispute.evidenceStatus = "submitted";
      dispute.evidenceSubmittedAt = now;
      dispute.humanEditedResponse = note || dispute.humanEditedResponse;
      dispute.status = "under_review";
    } else if (action === "RECORD_OFFER") {
      dispute.offerAmountUsd = body.offerAmountUsd ?? dispute.offerAmountUsd;
      dispute.offerSubmittedAt = now;
      dispute.humanEditedResponse = note || dispute.humanEditedResponse;
      dispute.status = "waiting_for_buyer";
    } else {
      dispute.status = "resolved";
      dispute.resolutionOutcome = body.outcome ?? "RESOLVED_INTERNAL_AGREEMENT";
      dispute.humanEditedResponse = note || dispute.humanEditedResponse;
    }
    dispute.updatedAt = now;

    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeId,
      event: `DISPUTE_HUMAN_${action}`,
      actor: `${role}-operator`,
      payload: { action, outcome: dispute.resolutionOutcome, simulated: true },
    });

    return NextResponse.json({ ok: true, dispute, simulated: true });
  }

  const [liveDispute] = await db
    .select({ id: disputes.id, milestoneId: disputes.milestoneId })
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);
  if (!liveDispute) {
    return NextResponse.json({ error: "dispute not found" }, { status: 404 });
  }
  if (await isCrossCompanyDispute(session, liveDispute.milestoneId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const now = new Date();
  const updates: Partial<typeof disputes.$inferInsert> = {
    updatedAt: now,
    humanEditedResponse: note || undefined,
  };

  if (action === "RECORD_EVIDENCE") {
    updates.evidenceStatus = "submitted";
    updates.evidenceSubmittedAt = now;
    updates.status = "under_review";
  } else if (action === "RECORD_OFFER") {
    updates.offerAmountUsd = body.offerAmountUsd ?? null;
    updates.offerSubmittedAt = now;
    updates.status = "waiting_for_buyer";
  } else {
    updates.status = "resolved";
    updates.resolutionOutcome = body.outcome ?? "RESOLVED_INTERNAL_AGREEMENT";
  }

  await db.update(disputes).set(updates).where(eq(disputes.id, disputeId));

  await writeAuditLog({
    entityType: "dispute",
    entityId: disputeId,
    event: `DISPUTE_HUMAN_${action}`,
    actor: `${role}-operator`,
    payload: { action, outcome: updates.resolutionOutcome },
  });

  const [updated] = await db
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  return NextResponse.json({ ok: true, dispute: updated });
}
