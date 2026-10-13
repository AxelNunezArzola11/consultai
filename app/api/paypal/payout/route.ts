/**
 * POST /api/paypal/payout
 *
 * Issues a PayPal Payout to a freelancer (recipient_type: EMAIL).
 * Body: { paymentId: string, recipientEmail: string, note?: string }
 *
 * Deterministic IDs (Phase 1 rule):
 *   sender_batch_id = "PAY_{payment.id}"   — idempotency key for the batch
 *   sender_item_id  = "ITEM_{payment.id}"  — idempotency key for the item
 *   These are stored on the payments row at ORDER creation time so they never change.
 *
 * Idempotent replay (observed Spike 1):
 *   On HTTP 400 with details[].field == "SENDER_BATCH_ID":
 *     GET the original batch via the self link in the 400 response body.
 *     Return the original batch data as a replay — no second payment created.
 *   Do NOT match on error.name — observed: "USER_BUSINESS_ERROR" (not "DUPLICATE_BATCH_ID").
 *   Doc: https://developer.paypal.com/docs/payouts/integrate/make-payouts/
 *
 * Approval gate:
 *   Payout amount compared against AUTO_APPROVE_THRESHOLD_USD env var (default: $500).
 *   Below or equal threshold → auto-approved; payout issued immediately.
 *   Above threshold → approval record created with decision "pending"; payout held.
 *   Approve via POST /api/paypal/payout/approve with { approvalId }.
 *
 * Payout amount:
 *   Uses payment.net_usd (what the platform holds after Orders fee).
 *   The payout fee (observed: $0.25 on $1.00 — UNVERIFIED flat vs %) is borne by the platform;
 *   the consultant receives the full net_usd amount.
 *   Doc: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/
 *
 * Docs:
 *   Payouts API:    https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#payouts_post
 *   Payout item:    https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#definition-payout_item_details
 *   Idempotency:    https://developer.paypal.com/docs/payouts/integrate/make-payouts/
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { paypalFetch, safeJson, getAccessToken } from "@/lib/paypal/client";
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

export const dynamic = "force-dynamic";

const AUTO_APPROVE_THRESHOLD = parseFloat(
  process.env.AUTO_APPROVE_THRESHOLD_USD ?? "500"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PayoutCreateResult {
  isReplay:       boolean;
  batchId:        string;
  batchStatus:    string;
  /** Present on replay from GET; absent from POST (observed Spike 1) */
  timeCreated?:   string;
  selfLink?:      string;
}

/**
 * Creates a payout batch via POST /v1/payments/payouts.
 * On idempotent-duplicate (HTTP 400, details[].field == "SENDER_BATCH_ID"):
 *   GETs the original batch via the self link and returns it with isReplay: true.
 * Doc: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#payouts_post
 */
async function createOrReplayPayout(
  senderBatchId: string,
  senderItemId:  string,
  recipientEmail: string,
  amountUsd:     string,
  note:          string
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
        amount: {
          value:    amountUsd,
          currency: "USD",
        },
        note:           note || "Milestone payment",
        sender_item_id: senderItemId,
        receiver:       recipientEmail,
      },
    ],
  });

  const res = await paypalFetch("/v1/payments/payouts", {
    method: "POST",
    body,
  });

  const data = await safeJson(res);

  if (res.status === 201) {
    // Success — payout created
    const header = data.batch_header as Record<string, unknown> | undefined;
    const links  = data.links as Array<Record<string, string>> | undefined;
    const selfLink = links?.find((l) => l.rel === "self")?.href;

    return {
      isReplay:    false,
      batchId:     (header?.payout_batch_id as string) ?? "",
      batchStatus: (header?.batch_status    as string) ?? "PENDING",
      timeCreated: undefined, // not in POST response per docs
      selfLink,
    };
  }

  if (res.status === 400) {
    // Check for idempotent duplicate: details[].field == "SENDER_BATCH_ID"
    const details = data.details as Array<Record<string, string>> | undefined;
    const isBatchIdDup = details?.some((d) => d.field === "SENDER_BATCH_ID");

    if (isBatchIdDup) {
      // GET the original batch via the self link
      // Per Phase 1 rules: do NOT rely on error.name (observed: "USER_BUSINESS_ERROR")
      const links  = data.links as Array<Record<string, string>> | undefined;
      const selfLink = links?.find((l) => l.rel === "self")?.href;

      console.log("[payout] Idempotent duplicate detected via SENDER_BATCH_ID field; fetching original batch");

      if (selfLink) {
        // GET the original batch
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

  // Non-idempotent error — throw to surface to caller
  throw new Error(
    `PayPal payout failed HTTP ${res.status}: ${JSON.stringify(data)}`
  );
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body           = await req.json().catch(() => null);
    const paymentId      = body?.paymentId      as string | undefined;
    const recipientEmail = body?.recipientEmail as string | undefined;
    const note           = (body?.note          as string | undefined) ?? "";

    if (!paymentId || !recipientEmail) {
      return NextResponse.json(
        { error: "paymentId and recipientEmail required" },
        { status: 400 }
      );
    }

    // Load payment row
    const [paymentRow] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);

    if (!paymentRow) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    // Only funded (captured) payments can be paid out
    if (paymentRow.status !== "processing" && paymentRow.status !== "on_hold") {
      return NextResponse.json(
        { error: `Payment status is '${paymentRow.status}' — must be 'processing' or 'on_hold' to pay out` },
        { status: 409 }
      );
    }

    // Payout amount = net_usd (what the platform holds after Orders fee)
    const netUsd = paymentRow.netUsd;
    if (!netUsd) {
      return NextResponse.json(
        { error: "Payment has no net_usd — capture may not have completed" },
        { status: 409 }
      );
    }
    const amountUsd = parseFloat(netUsd).toFixed(2);

    // Deterministic IDs (set at order creation; senderBatchId stored on payment row)
    const senderBatchId = paymentRow.senderBatchId ?? `PAY_${paymentId}`;
    const senderItemId  = `ITEM_${paymentId}`;

    // ── Approval gate ─────────────────────────────────────────────────────────
    const amountNum = parseFloat(amountUsd);
    const needsApproval = amountNum > AUTO_APPROVE_THRESHOLD;

    if (needsApproval) {
      // Check for an existing pending approval
      const [existingApproval] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.paymentId, paymentId))
        .limit(1);

      if (existingApproval && existingApproval.decision === "pending") {
        return NextResponse.json({
          status:           "pending_approval",
          approvalId:       existingApproval.id,
          message:          `Amount $${amountUsd} exceeds auto-approve threshold $${AUTO_APPROVE_THRESHOLD} — awaiting approval`,
          approvalDecision: "pending",
        });
      }

      if (existingApproval && existingApproval.decision === "rejected") {
        return NextResponse.json(
          { error: "Payout was rejected by approver", approvalId: existingApproval.id },
          { status: 409 }
        );
      }

      // No existing approval — create one and hold payment
      const approvalId = `apv_${nanoid(12)}`;

      await db.insert(approvals).values({
        id:          approvalId,
        paymentId,
        milestoneId: paymentRow.milestoneId,
        requestedBy: "system",
        decision:    "pending",
      });

      // Transition payment → on_hold (awaiting approval)
      const fromStatus = paymentRow.status as PaymentStatus;
      if (fromStatus !== "on_hold") {
        assertPaymentTransition(fromStatus, "on_hold");
        await db
          .update(payments)
          .set({ status: "on_hold", updatedAt: new Date() })
          .where(eq(payments.id, paymentId));
      }

      // Milestone → pending_approval
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
        payload: {
          approvalId,
          amountUsd,
          threshold: AUTO_APPROVE_THRESHOLD,
          recipientEmail,
        },
      });

      return NextResponse.json({
        status:     "pending_approval",
        approvalId,
        message:    `Amount $${amountUsd} exceeds threshold $${AUTO_APPROVE_THRESHOLD} — approval required`,
      });
    }

    // ── Issue payout (auto-approved or already approved) ─────────────────────
    const result = await createOrReplayPayout(
      senderBatchId,
      senderItemId,
      recipientEmail,
      amountUsd,
      note
    );

    console.log("[payout]", result.isReplay ? "REPLAY" : "CREATED", {
      paymentId,
      batchId:     result.batchId,
      batchStatus: result.batchStatus,
      isReplay:    result.isReplay,
      amountUsd,
    });

    // Store batch ID on payment row
    await db
      .update(payments)
      .set({
        paypalPayoutBatchId: result.batchId,
        status:              "processing",
        updatedAt:           new Date(),
      })
      .where(eq(payments.id, paymentId));

    // Milestone → verifying (payout submitted, awaiting PAYOUTS-ITEM.SUCCEEDED webhook)
    const [milestone] = await db
      .select()
      .from(milestones)
      .where(eq(milestones.id, paymentRow.milestoneId))
      .limit(1);

    if (milestone) {
      const fromMs = milestone.status as MilestoneStatus;
      // funded → pending_approval → verifying, or funded → verifying (auto-approve)
      if (fromMs !== "verifying") {
        // Try funded → pending_approval → verifying path first
        // or funded → verifying directly if auto-approved without intermediate hold
        const canGoVerifying =
          fromMs === "funded" ||
          fromMs === "pending_approval";

        if (canGoVerifying) {
          // For funded → verifying: go through pending_approval first
          if (fromMs === "funded") {
            assertMilestoneTransition("funded", "pending_approval");
            assertMilestoneTransition("pending_approval", "verifying");
          } else {
            assertMilestoneTransition(fromMs, "verifying");
          }
          await db
            .update(milestones)
            .set({
              paypalPayoutBatchId: result.batchId,
              status:              "verifying",
              updatedAt:           new Date(),
            })
            .where(eq(milestones.id, milestone.id));
        }
      }
    }

    await writeAuditLog({
      entityType: "payment",
      entityId:   paymentId,
      event:      result.isReplay ? "PAYOUT_REPLAY" : "PAYOUT_ISSUED",
      actor:      "system",
      payload: {
        batchId:        result.batchId,
        batchStatus:    result.batchStatus,
        senderBatchId,
        senderItemId,
        recipientEmail,
        amountUsd,
        isReplay:       result.isReplay,
        timeCreated:    result.timeCreated ?? null,
      },
    });

    return NextResponse.json({
      status:      "ok",
      isReplay:    result.isReplay,
      batchId:     result.batchId,
      batchStatus: result.batchStatus,
      senderBatchId,
      senderItemId,
      amountUsd,
      paymentId,
      message: result.isReplay
        ? "Idempotent replay — original batch returned, no second payment created"
        : `Payout issued — batch ${result.batchId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[payout] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
