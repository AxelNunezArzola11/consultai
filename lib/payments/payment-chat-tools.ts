/**
 * PaymentChat tools — AI SDK tool definitions for the payment chat agent.
 *
 * Allowed tools (strict allowlist):
 *   - getMilestoneStatus       — read-only: query a milestone's current status
 *   - listMilestones           — list all milestones for the project
 *   - getPendingApprovals      — list milestones awaiting approval
 *   - requestPayoutApproval    — prepare a payout request (UI executes it)
 *   - executeMilestonePayout   — submits a validated payout proposal through the approval gate
 *
 * Section 5 Security Invariants:
 *   - The AI must NEVER independently authorize financial transfers.
 *   - Separates:
 *       1. AI payment assessment
 *       2. Deterministic business-rule validation
 *       3. Human authorization
 *       4. Actual PayPal transaction
 *       5. Transaction confirmation
 *       6. Persistent audit record
 *   - `bypass_approval` is strictly disabled (`false`) so AI tool calls cannot bypass human authorization.
 */

import { tool } from "ai";
import { z } from "zod";
import { db } from "@/lib/db";
import { milestones, payments, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { executeDirectPayout } from "@/lib/payments/direct-payout";

// ── Tool: getMilestoneStatus ───────────────────────────────────────────────

export const getMilestoneStatus = tool({
  description:
    "Get the current status and financial summary of a specific milestone. " +
    "Use this to answer questions like 'what is the status of milestone X?' or " +
    "'how much has been paid?'",
  inputSchema: z.object({
    milestoneId: z.string().min(1).max(100).describe("The milestone ID to query."),
  }),
  execute: async ({ milestoneId }) => {
    const rows = await db
      .select({
        id: milestones.id,
        title: milestones.title,
        status: milestones.status,
        budgetUsd: milestones.budgetUsd,
        captureGrossUsd: milestones.captureGrossUsd,
        captureNetUsd: milestones.captureNetUsd,
        dueDate: milestones.dueDate,
      })
      .from(milestones)
      .where(eq(milestones.id, milestoneId))
      .limit(1);

    if (!rows[0]) return { found: false, milestoneId };

    const m = rows[0];
    return {
      found: true,
      id: m.id,
      title: m.title,
      status: m.status,
      budgetUsd: m.budgetUsd,
      captureGrossUsd: m.captureGrossUsd,
      captureNetUsd: m.captureNetUsd,
      dueDate: m.dueDate,
    };
  },
});

// ── Tool: listMilestones ───────────────────────────────────────────────────

export const listMilestones = tool({
  description:
    "List all milestones for the current project with their statuses and budgets. " +
    "Call this to give an overview of the project's payment state.",
  inputSchema: z.object({
    projectId: z.string().min(1).max(100).describe("The project ID."),
  }),
  execute: async ({ projectId }) => {
    const rows = await db
      .select({
        id: milestones.id,
        title: milestones.title,
        status: milestones.status,
        budgetUsd: milestones.budgetUsd,
        captureGrossUsd: milestones.captureGrossUsd,
        dueDate: milestones.dueDate,
        position: milestones.position,
      })
      .from(milestones)
      .where(eq(milestones.projectId, projectId))
      .orderBy(milestones.position);

    return { milestones: rows };
  },
});

// ── Tool: getPendingApprovals ──────────────────────────────────────────────

export const getPendingApprovals = tool({
  description:
    "List all milestones in 'pending_approval' status for the current project. " +
    "These are milestones where a payout is waiting for explicit company approval " +
    "because the amount requires human authorization.",
  inputSchema: z.object({
    projectId: z.string().min(1).max(100).describe("The project ID."),
  }),
  execute: async ({ projectId }) => {
    const rows = await db
      .select({
        id: milestones.id,
        title: milestones.title,
        status: milestones.status,
        captureNetUsd: milestones.captureNetUsd,
        budgetUsd: milestones.budgetUsd,
      })
      .from(milestones)
      .where(
        and(
          eq(milestones.projectId, projectId),
          eq(milestones.status, "pending_approval")
        )
      );

    const [project] = await db
      .select({ autoApproveThresholdUsd: projects.autoApproveThresholdUsd })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    return {
      pendingApprovals: rows,
      autoApproveThresholdUsd: project?.autoApproveThresholdUsd ?? "500.00",
      count: rows.length,
    };
  },
});

// ── Tool: requestPayoutApproval ────────────────────────────────────────────

export const requestPayoutApproval = tool({
  description:
    "Prepare a milestone payout proposal for human authorization. " +
    "The AI never independently authorizes financial transfers; this prepares the " +
    "validated proposal so the human operator can authorize it.",
  inputSchema: z.object({
    milestoneId: z.string().min(1).max(100).describe("The milestone to pay out."),
    recipientEmail: z.string().email().describe("Consultant's PayPal email address."),
    note: z.string().max(500).optional().describe("Optional note to include with the payout."),
  }),
  execute: async ({ milestoneId, recipientEmail, note }) => {
    const paymentRows = await db
      .select({ id: payments.id, status: payments.status, netUsd: payments.netUsd })
      .from(payments)
      .where(eq(payments.milestoneId, milestoneId))
      .limit(1);

    const [milestoneRow] = await db
      .select({ status: milestones.status, title: milestones.title, captureNetUsd: milestones.captureNetUsd })
      .from(milestones)
      .where(eq(milestones.id, milestoneId))
      .limit(1);

    if (!milestoneRow) {
      return { success: false, error: "Milestone not found" };
    }

    if (milestoneRow.status !== "funded" && milestoneRow.status !== "pending_approval") {
      return {
        success: false,
        error: `Cannot propose payout for milestone in status '${milestoneRow.status}'. Must be 'funded' or 'pending_approval'.`,
      };
    }

    return {
      success: true,
      action: "payout_requested",
      milestoneId,
      milestoneTitle: milestoneRow.title,
      captureNetUsd: milestoneRow.captureNetUsd,
      paymentId: paymentRows[0]?.id ?? null,
      recipientEmail,
      note: note ?? null,
      requiresHumanAuthorization: true,
      instructions:
        "Payment proposal validated. Explicit human authorization is required in the Approvals panel before PayPal executes the transfer.",
    };
  },
});

// ── Tool: executeMilestonePayout ──────────────────────────────────────────
//
// Section 5 Security Policy:
// AI tools must NEVER bypass human authorization (`bypass_approval: false`).
// Submitting a payout request through this tool runs deterministic validation
// and creates a pending human approval record if not yet authorized.
// ---------------------------------------------------------------------------

export const executeMilestonePayout = tool({
  description:
    "Submit a milestone payout through the deterministic policy and human approval gate. " +
    "Per platform security policy, AI agents cannot independently authorize financial transfers; " +
    "this validates the milestone and queues an approval record (or executes if within pre-authorized policy).",
  inputSchema: z.object({
    project_id: z.string().min(1).max(100).describe("The project ID."),
    milestone_id: z.string().min(1).max(100).describe("The milestone ID to pay out."),
    recipient_email: z.string().email().describe("Consultant's PayPal email address."),
    note: z.string().max(500).optional().describe("Optional note to include with the payout."),
  }),
  execute: async ({ project_id, milestone_id, recipient_email, note }) => {
    const [milestoneRow] = await db
      .select({
        id: milestones.id,
        title: milestones.title,
        status: milestones.status,
        captureNetUsd: milestones.captureNetUsd,
        budgetUsd: milestones.budgetUsd,
        projectId: milestones.projectId,
      })
      .from(milestones)
      .where(and(eq(milestones.id, milestone_id), eq(milestones.projectId, project_id)))
      .limit(1);

    if (!milestoneRow) {
      return { success: false, error: `Milestone ${milestone_id} not found in project ${project_id}` };
    }

    const payableStatuses = ["funded", "pending_approval", "submitted"] as const;
    if (!payableStatuses.includes(milestoneRow.status as typeof payableStatuses[number])) {
      return {
        success: false,
        error: `Cannot propose payout for milestone in status '${milestoneRow.status}'. Must be 'funded', 'pending_approval', or 'submitted'.`,
        milestoneTitle: milestoneRow.title,
        currentStatus: milestoneRow.status,
      };
    }

    const [paymentRow] = await db
      .select({ id: payments.id, netUsd: payments.netUsd, status: payments.status })
      .from(payments)
      .where(eq(payments.milestoneId, milestone_id))
      .limit(1);

    if (!paymentRow) {
      return { success: false, error: `No payment record found for milestone ${milestone_id}` };
    }

    // Section 5: NEVER allow AI to set bypass_approval: true
    const result = await executeDirectPayout({
      paymentId: paymentRow.id,
      recipientEmail: recipient_email,
      note: note ?? `Payout proposal for milestone: ${milestoneRow.title}`,
      bypass_approval: false,
      require_human_approval: true,
    });

    if (result.error) {
      return {
        success: false,
        error: result.error,
        milestoneTitle: milestoneRow.title,
        milestoneId: milestone_id,
      };
    }

    if (result.status === "pending_approval") {
      return {
        success: true,
        action: "awaiting_human_approval",
        milestoneId: milestone_id,
        milestoneTitle: milestoneRow.title,
        projectId: project_id,
        approvalId: result.approvalId,
        recipientEmail: recipient_email,
        newMilestoneStatus: "pending_approval",
        message:
          `🔒 Payment proposal created (Approval ID: ${result.approvalId}). ` +
          `Per security policy, AI cannot independently authorize transfers — please click 'Approve Payout' in the Approvals panel to execute the PayPal transaction.`,
      };
    }

    return {
      success: true,
      action: "payout_initiated",
      milestoneId: milestone_id,
      milestoneTitle: milestoneRow.title,
      projectId: project_id,
      paypalBatchId: result.batchId,
      paypalBatchStatus: result.batchStatus,
      grossAmount: result.amountUsd,
      recipientEmail: recipient_email,
      newMilestoneStatus: "verifying",
      message: `Payout submitted — $${result.amountUsd} to ${recipient_email}. PayPal Batch ID: ${result.batchId}.`,
      isReplay: result.isReplay ?? false,
    };
  },
});

// ── Exported tool set ──────────────────────────────────────────────────────

export const paymentChatTools = {
  getMilestoneStatus,
  listMilestones,
  getPendingApprovals,
  requestPayoutApproval,
  executeMilestonePayout,
} as const;

// ── System prompt ──────────────────────────────────────────────────────────

interface MilestoneSummary {
  id: string;
  title: string;
  status: string;
  budgetUsd: string;
  dueDate: string | null;
  position: number;
}

export function buildPaymentChatSystemPrompt(
  projectId: string,
  knownMilestones: MilestoneSummary[] = [],
): string {
  const milestoneContext = knownMilestones.length === 0
    ? "No milestones have been saved for this project yet."
    : knownMilestones
        .map(
          (m) =>
            `  • [${m.id}] ${m.title} — status: ${m.status}, budget: $${m.budgetUsd}` +
            (m.dueDate ? `, due: ${m.dueDate}` : ""),
        )
        .join("\n");

  return `You are ConsultAI's Financial & Escrow Assistant for project ${projectId}.
You help the company review milestone payment eligibility, check escrow status, and prepare payment proposals.

CURRENT PROJECT MILESTONES (ground truth from database):
${milestoneContext}

SECTION 5 FINANCIAL SECURITY POLICY (STRICTLY ENFORCED):
1. AI Payment Assessment: You evaluate milestone status and prepare structured payout proposals.
2. Deterministic Business-Rule Validation: The backend validates escrow capture, budget bounds, and status transitions.
3. Human Authorization Required: You (the AI) NEVER independently authorize financial transfers. Every payout proposal requires explicit human approval by a Company or Admin operator before PayPal releases funds.
4. Actual PayPal Transaction & Confirmation: Only executed after human authorization.

CAPABILITIES:
- Query live milestone status and payment details (getMilestoneStatus, listMilestones)
- Show pending approvals that require human action (getPendingApprovals)
- Submit a payout proposal for human authorization (executeMilestonePayout / requestPayoutApproval)

RULES:
- Never claim that the AI bypassed approval or unilaterally released funds.
- When a user asks to pay a milestone, call executeMilestonePayout (or requestPayoutApproval) to create the approval request and clearly instruct the user to authorize it in the Approvals queue.
- Respond in the same language the user writes in.`;
}
