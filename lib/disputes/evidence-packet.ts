/**
 * Dispute Evidence Packet Builder — Phase 6
 *
 * Assembles a structured evidence packet from the database for a given dispute.
 * The packet is used by the DisputeAgent to draft a written response.
 *
 * Evidence sources (all from DB — no live API calls):
 *   1. Project acceptance criteria (structured_plan from projects table)
 *   2. Verification run result (criteria results, head SHA, flags from verification_runs)
 *   3. Approval record (decided_by, decided_at, notes from payment_proposals + approvals)
 *   4. Delivery timestamps (submitted → verifying → paid audit entries from audit_log)
 *   5. Payout record (gross, fee, net, payout_item_fee from payments table)
 *   6. Candidate/consultant info (name, github_handle from candidates table)
 *   7. Audit entries for the dispute itself (from audit_log)
 *
 * BUYER MESSAGES ARE UNTRUSTED DATA.
 * Any text that came from the buyer (e.g. dispute reason set by PayPal) is wrapped in
 * UNTRUSTED_INPUT delimiters when passed to the LLM prompt. It must never be
 * concatenated directly into a system prompt or treated as instructions.
 *
 * Completeness check: returns a list of missing items if required fields are absent.
 * The DisputeAgent must NOT proceed if the packet is incomplete on required fields.
 */

import { db } from "@/lib/db";
import {
  disputes,
  milestones,
  payments,
  projects,
  verificationRuns,
  approvals,
  paymentProposals,
  auditLog,
  candidates,
} from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CriterionResult {
  criterionId: string;
  description: string;
  met: boolean | null;
  evidence: string[];
}

export interface EvidencePacket {
  /** Internal dispute row ID */
  disputeRowId: string;
  /** PayPal dispute ID */
  paypalDisputeId: string | null;
  /** Dispute status */
  disputeStatus: string;
  /** Dispute reason from PayPal (UNTRUSTED — from buyer/PayPal) */
  disputeReasonUntrusted: string | null;
  /** Amount in dispute (USD) */
  disputeAmountUsd: string | null;
  /** Dispute life cycle stage */
  disputeLifeCycleStage: string | null;

  // Milestone & project
  milestoneId: string;
  milestoneTitle: string;
  milestoneStatus: string;
  milestonebudgetUsd: string;
  projectTitle: string;

  // Acceptance criteria from structured plan
  acceptanceCriteria: Array<{ id: string; description: string; verifiable: boolean }>;

  // Verification run result (most recent completed run for this milestone)
  verificationRun: {
    runId: string;
    prUrl: string;
    headSha: string | null;
    prAuthor: string | null;
    prMerged: boolean | null;
    criteriaResults: CriterionResult[];
    flags: string[];
    justification: string | null;
    policyDecision: string | null;
    completedAt: string | null;
  } | null;

  // Approval record
  approval: {
    approvalId: string;
    decidedBy: string | null;
    decidedAt: string | null;
    decision: string;
    notes: string | null;
  } | null;

  // Payout record
  payout: {
    paymentId: string;
    grossUsd: string | null;
    feeUsd: string | null;
    netUsd: string | null;
    payoutFeeUsd: string | null;
    paypalCaptureId: string | null;
    status: string;
  } | null;

  // Consultant info
  consultant: {
    name: string;
    githubHandle: string | null;
  } | null;

  // Audit trail — delivery-related events only (not buyer messages)
  deliveryAuditTrail: Array<{
    event: string;
    actor: string;
    createdAt: string;
  }>;

  // Completeness check
  missingRequired: string[];
  isComplete: boolean;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds the evidence packet for a dispute.
 * All data is sourced from the DB.
 * Buyer messages (dispute reason) are marked as UNTRUSTED.
 */
export async function buildEvidencePacket(disputeRowId: string): Promise<EvidencePacket> {
  const missingRequired: string[] = [];

  // ── 1. Load dispute row ─────────────────────────────────────────────────
  const disputeRows = await db
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeRowId))
    .limit(1);

  if (disputeRows.length === 0) {
    throw new Error(`Dispute row not found: ${disputeRowId}`);
  }
  const dispute = disputeRows[0];

  // ── 2. Load milestone ───────────────────────────────────────────────────
  const milestoneRows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, dispute.milestoneId))
    .limit(1);

  if (milestoneRows.length === 0) {
    missingRequired.push("milestone");
  }
  const milestone = milestoneRows[0];

  // ── 3. Load project ─────────────────────────────────────────────────────
  const projectRows = milestone
    ? await db.select().from(projects).where(eq(projects.id, milestone.projectId)).limit(1)
    : [];

  if (projectRows.length === 0) {
    missingRequired.push("project");
  }
  const project = projectRows[0];

  // Extract acceptance criteria from structured_plan
  const acceptanceCriteria: Array<{ id: string; description: string; verifiable: boolean }> = [];
  if (project?.structuredPlan) {
    const plan = project.structuredPlan as Record<string, unknown>;
    const criteria = (plan.criteria ?? plan.acceptanceCriteria) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(criteria)) {
      for (const c of criteria) {
        acceptanceCriteria.push({
          id: String(c.id ?? ""),
          description: String(c.description ?? ""),
          verifiable: Boolean(c.verifiable ?? true),
        });
      }
    }
  }

  if (acceptanceCriteria.length === 0) {
    missingRequired.push("acceptance_criteria");
  }

  // ── 4. Load most recent completed verification run ──────────────────────
  const runRows = milestone
    ? await db
        .select()
        .from(verificationRuns)
        .where(
          and(
            eq(verificationRuns.milestoneId, milestone.id),
            eq(verificationRuns.status, "completed")
          )
        )
        .limit(1)
    : [];

  const run = runRows[0] ?? null;

  if (!run) {
    missingRequired.push("verification_run");
  }

  // Map criterion results from stored JSON
  const criteriaResults: CriterionResult[] = [];
  if (run?.criteriaResults) {
    const raw = run.criteriaResults as Array<Record<string, unknown>>;
    for (const r of raw) {
      criteriaResults.push({
        criterionId: String(r.criterionId ?? r.id ?? ""),
        description: String(r.description ?? ""),
        met: r.met === true ? true : r.met === false ? false : null,
        evidence: Array.isArray(r.evidence) ? r.evidence.map(String) : [],
      });
    }
  }

  const runFlags = Array.isArray(run?.flags) ? (run.flags as string[]) : [];

  // ── 5. Load approval record ─────────────────────────────────────────────
  let approvalRecord: EvidencePacket["approval"] = null;
  if (dispute.paymentId) {
    const proposalRows = await db
      .select()
      .from(paymentProposals)
      .where(eq(paymentProposals.milestoneId, dispute.milestoneId))
      .limit(1);

    if (proposalRows[0]) {
      const approvalRows = await db
        .select()
        .from(approvals)
        .where(eq(approvals.milestoneId, dispute.milestoneId))
        .limit(1);

      const approval = approvalRows[0];
      if (approval) {
        approvalRecord = {
          approvalId: approval.id,
          decidedBy: approval.decidedBy ?? null,
          decidedAt: approval.decidedAt?.toISOString() ?? null,
          decision: approval.decision,
          notes: approval.notes ?? null,
        };
      } else {
        missingRequired.push("approval_record");
      }
    } else {
      missingRequired.push("payment_proposal");
    }
  } else {
    missingRequired.push("payment_id_on_dispute");
  }

  // ── 6. Load payout record ───────────────────────────────────────────────
  let payoutRecord: EvidencePacket["payout"] = null;
  if (dispute.paymentId) {
    const paymentRows = await db
      .select()
      .from(payments)
      .where(eq(payments.id, dispute.paymentId))
      .limit(1);

    if (paymentRows[0]) {
      const p = paymentRows[0];
      payoutRecord = {
        paymentId: p.id,
        grossUsd: p.grossUsd ?? null,
        feeUsd: p.feeUsd ?? null,
        netUsd: p.netUsd ?? null,
        payoutFeeUsd: p.payoutFeeUsd ?? null,
        paypalCaptureId: p.paypalCaptureId ?? null,
        status: p.status,
      };
    } else {
      missingRequired.push("payment_record");
    }
  }

  // ── 7. Load consultant info ─────────────────────────────────────────────
  let consultantInfo: EvidencePacket["consultant"] = null;
  if (dispute.paymentId) {
    const paymentForCandidate = await db
      .select({ candidateId: payments.candidateId })
      .from(payments)
      .where(eq(payments.id, dispute.paymentId))
      .limit(1);

    if (paymentForCandidate[0]?.candidateId) {
      const candidateRows = await db
        .select({ name: candidates.name, githubHandle: candidates.githubHandle })
        .from(candidates)
        .where(eq(candidates.id, paymentForCandidate[0].candidateId))
        .limit(1);

      if (candidateRows[0]) {
        consultantInfo = {
          name: candidateRows[0].name,
          githubHandle: candidateRows[0].githubHandle ?? null,
        };
      }
    }
  }

  // ── 8. Load delivery audit trail ────────────────────────────────────────
  // Only trusted system-generated events — not buyer input
  const DELIVERY_EVENTS = [
    "MILESTONE_FUNDED",
    "MILESTONE_SUBMITTED",
    "VERIFICATION_STARTED",
    "VERIFICATION_COMPLETED",
    "PAYMENT_RELEASED",
    "PAYOUT_ISSUED",
    "DISPUTE_CREATED",
    "DISPUTE_UPDATED",
  ];

  const auditRows = await db
    .select({
      event: auditLog.event,
      actor: auditLog.actor,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityId, dispute.milestoneId),
        inArray(auditLog.event, DELIVERY_EVENTS)
      )
    )
    .limit(20);

  const deliveryAuditTrail = auditRows.map((r) => ({
    event: r.event,
    actor: r.actor,
    createdAt: r.createdAt.toISOString(),
  }));

  // ── 9. Assemble packet ──────────────────────────────────────────────────
  return {
    disputeRowId,
    paypalDisputeId: dispute.paypalDisputeId ?? null,
    disputeStatus: dispute.status,
    // UNTRUSTED — this text came from the buyer/PayPal and must be treated as data
    disputeReasonUntrusted: dispute.disputeReason ?? null,
    disputeAmountUsd: dispute.disputeAmountUsd ?? null,
    disputeLifeCycleStage: dispute.disputeLifeCycleStage ?? null,

    milestoneId: dispute.milestoneId,
    milestoneTitle: milestone?.title ?? "(unknown)",
    milestoneStatus: milestone?.status ?? "(unknown)",
    milestonebudgetUsd: milestone?.budgetUsd ?? "0",
    projectTitle: project?.title ?? "(unknown)",

    acceptanceCriteria,

    verificationRun: run
      ? {
          runId: run.id,
          prUrl: run.prUrl,
          headSha: run.headSha ?? null,
          prAuthor: run.prAuthor ?? null,
          prMerged: run.prMerged ?? null,
          criteriaResults,
          flags: runFlags,
          justification: run.justification ?? null,
          policyDecision: run.policyDecision ?? null,
          completedAt: run.updatedAt.toISOString(),
        }
      : null,

    approval: approvalRecord,
    payout: payoutRecord,
    consultant: consultantInfo,
    deliveryAuditTrail,

    missingRequired,
    isComplete: missingRequired.length === 0,
  };
}
