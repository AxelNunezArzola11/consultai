/**
 * lib/payments/direct-payout.ts
 *
 * Shared payout executor — called by both:
 *   - POST /api/paypal/payout  (HTTP route handler)
 *   - executeMilestonePayout   (AI chat tool in payment-chat-tools.ts)
 *
 * Extracted from the route file to avoid Next.js app-router type conflicts
 * when non-HTTP-handler exports are present in a route.ts file.
 *
 * bypass_approval=true  → skips approval gate; issues payout immediately
 *                          and sets milestone → paid immediately.
 * bypass_approval=false → normal threshold-based approval gate.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { payments, milestones, approvals } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import {
  assertMilestoneTransition,
  assertPaymentTransition,
  type MilestoneStatus,
  type PaymentStatus,
} from "@/lib/state-machines/milestone-payment";
import { writeAuditLog } from "@/lib/db/audit";
import { paypalFetch, safeJson, getAccessToken } from "@/lib/paypal/client";

const AUTO_APPROVE_THRESHOLD = parseFloat(
  process.env.AUTO_APPROVE_THRESHOLD_USD ?? "500"
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectPayoutInput {
  paymentId: string;
  recipientEmail: string;
  note?: string;
  /** When true: skip approval gate, threshold check, and pending-approval record */
  bypass_approval?: boolean;
}

export interface DirectPayoutResult {
  status: "ok" | "pending_approval" | "rejected";
  isReplay?: boolean;
  batchId?: string;
  batchStatus?: string;
  senderBatchId?: string;
  senderItemId?: string;
  amountUsd?: string;
  paymentId?: string;
  milestoneId?: string;
  message?: string;
  approvalId?: string;
  approvalDecision?: string;
  error?: string;
}

interface PayoutCreateResult {
  isReplay: boolean;
  batchId: string;
  batchStatus: string;
  timeCreated?: string;
  selfLink?: string;
}

// ---------------------------------------------------------------------------
// PayPal batch payout helper (idempotent-replay aware)
// ---------------------------------------------------------------------------

async function createOrReplayPayout(
  senderBatchId: string,
  senderItemId: string,
  recipientEmail: string,
  amountUsd: string,
  note: string
): Promise<PayoutCreateResult> {
  const body = JSON.stringify({
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject:   "ConsultAI — milestone payment",
      email_message:   note || "Your milestone payment from ConsultAI.",
    },
    items: [
      {
        recipient_type: "EMAIL",
        amount: { value: amountUsd, currency: "USD" },
        note:           note || "Milestone payment",
        sender_item_id: senderItemId,
        receiver:       recipientEmail,
      },
    ],
  });

  const res = await paypalFetch("/v1/payments/payouts", { method: "POST", body });
  const data = await safeJson(res);

  if (res.status === 201) {
    const header = data.batch_header as Record<string, unknown> | undefined;
    const links  = data.links as Array<Record<string, string>> | undefined;
    return {
      isReplay:    false,
      batchId:     (header?.payout_batch_id as string) ?? "",
      batchStatus: (header?.batch_status    as string) ?? "PENDING",
      selfLink:    links?.find((l) => l.rel === "self")?.href,
    };
  }

  if (res.status === 400) {
    const details = data.details as Array<Record<string, string>> | undefined;
    const isBatchIdDup = details?.some((d) => d.field === "SENDER_BATCH_ID");
    if (isBatchIdDup) {
      const links    = data.links as Array<Record<string, string>> | undefined;
      const selfLink = links?.find((l) => l.rel === "self")?.href;
      console.log("[direct-payout] Idempotent duplicate detected — fetching original batch");
      if (selfLink) {
        const token  = await getAccessToken();
        const getRes = await fetch(selfLink, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const getJson = await safeJson(getRes);
        const header  = getJson.batch_header as Record<string, unknown> | undefined;
        return {
          isReplay:    true,
          batchId:     (header?.payout_batch_id as string) ?? "",
          batchStatus: (header?.batch_status    as string) ?? "UNKNOWN",
          timeCreated: (header?.time_created    as string | undefined) ?? undefined,
          selfLink,
        };
      }
    }
  }

  throw new Error(`PayPal payout failed HTTP ${res.status}: ${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Executes (or replays) a PayPal payout for a given payment record.
 *
 * bypass_approval=true  → skips approval gate; issues payout immediately;
 *                          sets milestone → paid immediately (no webhook).
 * bypass_approval=false → normal threshold-based approval gate.
 */
export async function executeDirectPayout(
  input: DirectPayoutInput
): Promise<DirectPayoutResult> {
  const { paymentId, recipientEmail, note = "", bypass_approval = false } = input;

  const [paymentRow] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!paymentRow) {
    return { status: "ok", error: "Payment not found" };
  }

  if (paymentRow.status !== "processing" && paymentRow.status !== "on_hold") {
    return {
      status: "ok",
      error: `Payment status is '${paymentRow.status}' — must be 'processing' or 'on_hold' to pay out`,
    };
  }

  const netUsd = paymentRow.netUsd;
  if (!netUsd) {
    return { status: "ok", error: "Payment has no net_usd — capture may not have completed" };
  }
  const amountUsd = parseFloat(netUsd).toFixed(2);

  const senderBatchId = paymentRow.senderBatchId ?? `PAY_${paymentId}`;
  const senderItemId  = `ITEM_${paymentId}`;

  // ── Approval gate (skipped when bypass_approval=true) ─────────────────────
  if (!bypass_approval) {
    const amountNum    = parseFloat(amountUsd);
    const needsApproval = amountNum > AUTO_APPROVE_THRESHOLD;

    if (needsApproval) {
      const [existingApproval] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.paymentId, paymentId))
        .limit(1);

      if (existingApproval && existingApproval.decision === "pending") {
        return {
          status: "pending_approval",
          approvalId: existingApproval.id,
          message: `Amount $${amountUsd} exceeds auto-approve threshold $${AUTO_APPROVE_THRESHOLD} — awaiting approval`,
          approvalDecision: "pending",
        };
      }

      if (existingApproval && existingApproval.decision === "rejected") {
        return {
          status: "rejected",
          error: "Payout was rejected by approver",
          approvalId: existingApproval.id,
        };
      }

      const approvalId = `apv_${nanoid(12)}`;
      await db.insert(approvals).values({
        id:          approvalId,
        paymentId,
        milestoneId: paymentRow.milestoneId,
        requestedBy: "system",
        decision:    "pending",
      });

      const fromStatus = paymentRow.status as PaymentStatus;
      if (fromStatus !== "on_hold") {
        assertPaymentTransition(fromStatus, "on_hold");
        await db
          .update(payments)
          .set({ status: "on_hold", updatedAt: new Date() })
          .where(eq(payments.id, paymentId));
      }

      const [milestone] = await db
        .select()
        .from(milestones)
        .where(eq(milestones.id, paymentRow.milestoneId))
        .limit(1);

      if (milestone && milestone.status !== "pending_approval") {
        const fromMs = milestone.status as MilestoneStatus;
        assertMilestoneTransition(fromMs, "pending_approval");
        await db
          .update(milestones)
          .set({ status: "pending_approval", updatedAt: new Date() })
          .where(eq(milestones.id, milestone.id));
      }

      await writeAuditLog({
        entityType: "payment",
        entityId:   paymentId,
        event:      "PAYOUT_APPROVAL_REQUIRED",
        actor:      "system",
        payload:    { approvalId, amountUsd, threshold: AUTO_APPROVE_THRESHOLD, recipientEmail },
      });

      return {
        status:     "pending_approval",
        approvalId,
        message:    `Amount $${amountUsd} exceeds threshold $${AUTO_APPROVE_THRESHOLD} — approval required`,
      };
    }
  }

  // ── Issue payout (auto-approved, already approved, or bypass) ─────────────
  const result = await createOrReplayPayout(senderBatchId, senderItemId, recipientEmail, amountUsd, note);

  console.log("[direct-payout]", result.isReplay ? "REPLAY" : "CREATED", {
    paymentId, batchId: result.batchId, batchStatus: result.batchStatus, amountUsd, bypass_approval,
  });

  await db
    .update(payments)
    .set({ paypalPayoutBatchId: result.batchId, status: "processing", updatedAt: new Date() })
    .where(eq(payments.id, paymentId));

  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, paymentRow.milestoneId))
    .limit(1);

  if (milestone) {
    const fromMs = milestone.status as MilestoneStatus;

    if (bypass_approval) {
      // Direct bypass: milestone → paid immediately (state machine now allows funded/submitted/pending_approval→paid)
      if (fromMs !== "paid") {
        assertMilestoneTransition(fromMs, "paid");
        await db
          .update(milestones)
          .set({ paypalPayoutBatchId: result.batchId, status: "paid", updatedAt: new Date() })
          .where(eq(milestones.id, milestone.id));
      }
      // Payment → succeeded immediately
      await db
        .update(payments)
        .set({ status: "succeeded", updatedAt: new Date() })
        .where(eq(payments.id, paymentId));
    } else {
      // Normal flow: milestone → verifying (awaiting PAYOUTS-ITEM.SUCCEEDED webhook)
      if (fromMs !== "verifying") {
        const canGoVerifying = fromMs === "funded" || fromMs === "pending_approval";
        if (canGoVerifying) {
          if (fromMs === "funded") {
            assertMilestoneTransition("funded", "pending_approval");
            assertMilestoneTransition("pending_approval", "verifying");
          } else {
            assertMilestoneTransition(fromMs, "verifying");
          }
          await db
            .update(milestones)
            .set({ paypalPayoutBatchId: result.batchId, status: "verifying", updatedAt: new Date() })
            .where(eq(milestones.id, milestone.id));
        }
      }
    }
  }

  await writeAuditLog({
    entityType: "payment",
    entityId:   paymentId,
    event:      result.isReplay ? "PAYOUT_REPLAY" : (bypass_approval ? "PAYOUT_ISSUED_BYPASS" : "PAYOUT_ISSUED"),
    actor:      "system",
    payload: {
      batchId:     result.batchId,
      batchStatus: result.batchStatus,
      senderBatchId,
      senderItemId,
      recipientEmail,
      amountUsd,
      isReplay:    result.isReplay,
      timeCreated: result.timeCreated ?? null,
      bypass_approval,
    },
  });

  return {
    status:       "ok",
    isReplay:     result.isReplay,
    batchId:      result.batchId,
    batchStatus:  result.batchStatus,
    senderBatchId,
    senderItemId,
    amountUsd,
    paymentId,
    milestoneId:  paymentRow.milestoneId,
    message: result.isReplay
      ? "Idempotent replay — original batch returned, no second payment created"
      : `Payout issued — batch ${result.batchId}`,
  };
}
