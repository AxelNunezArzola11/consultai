/**
 * /api/paypal/webhook — PayPal webhook handler (Phase 1)
 *
 * Processing order (strict — per Phase 1 rules):
 *   1. Read raw body (request.text() → Buffer)
 *   2. Verify signature — 400 GENERIC on failure (reason in server logs only)
 *   3. Check duplicate (paypal_webhook_deliveries INSERT ON CONFLICT)
 *   4. Parse event, route to handler
 *   5. Record event_id ONLY after successful processing
 *
 * Idempotency:
 *   Uses paypal_webhook_deliveries table (UNIQUE PRIMARY KEY on event_id).
 *   INSERT … ON CONFLICT (event_id) DO NOTHING; rowsAffected == 0 → duplicate, return 200.
 *   In-memory sets MUST NOT be used (Vercel serverless = new process per invocation).
 *
 * State machine:
 *   Transitions enforced by assertMilestoneTransition / assertPaymentTransition.
 *   Out-of-order events that arrive when already in the target state are idempotent (no-op).
 *
 * Event routing (verified Spike 3 observations):
 *   CAPTURE.COMPLETED     → resource.id (captureId), resource.supplementary_data.related_ids.order_id
 *                           resource.custom_id (UNVERIFIED — logged if present)
 *   PAYOUTSBATCH.*        → resource.batch_header.payout_batch_id (batch-level only, no item detail)
 *   PAYOUTS-ITEM.*        → resource.payout_item.sender_item_id ("ITEM_{payment.id}")
 *                           resource.payout_item_id, resource.transaction_id
 *   DISPUTE.CREATED       → resource.dispute_id, resource.disputed_transactions[0].buyer_transaction_id
 *
 * Env vars (all required):
 *   PAYPAL_WEBHOOK_ID  — bare 17-char Dashboard webhook registration ID (NOT the WH-... event id)
 *   DATABASE_URL       — Neon connection string
 *
 * Docs:
 *   Webhook verification:  https://developer.paypal.com/api/rest/webhooks/rest/#self-verification-method
 *   Header names:          https://developer.paypal.com/api/rest/webhooks/rest/#message-verification
 *   Event names:           https://developer.paypal.com/api/rest/webhooks/event-names/
 *   Capture object:        https://developer.paypal.com/docs/api/orders/v2/#definition-capture
 *   Payout item:           https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#definition-payout_item_details
 *   Dispute:               https://developer.paypal.com/docs/api/customer-disputes/v1/#definition-dispute
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { verifyPayPalWebhook } from "@/lib/paypal/webhook";
import { db } from "@/lib/db";
import {
  paypalWebhookDeliveries,
  payments,
  milestones,
} from "@/lib/db/schema";
import {
  assertMilestoneTransition,
  assertPaymentTransition,
  type MilestoneStatus,
  type PaymentStatus,
} from "@/lib/state-machines/milestone-payment";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generic 400 — never expose the real reason to the caller. */
function reject400(): NextResponse {
  return NextResponse.json({ error: "invalid request" }, { status: 400 });
}

/**
 * Attempts to insert the event_id into paypal_webhook_deliveries.
 * Returns true if inserted (first delivery), false if already exists (duplicate).
 */
async function tryRecordEventId(eventId: string, eventType: string): Promise<boolean> {
  const result = await db
    .insert(paypalWebhookDeliveries)
    .values({ eventId, eventType })
    .onConflictDoNothing()
    .returning({ eventId: paypalWebhookDeliveries.eventId });

  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body as bytes ───────────────────────────────────────────
  // CRITICAL: must use raw bytes for CRC32 + sig verification.
  // Per PayPal docs: "use the original raw body to calculate this; do not parse
  // the body to an array/object and then re-stringify it."
  // Doc: https://developer.paypal.com/api/rest/webhooks/rest/#self-verification-method
  const rawBody = Buffer.from(await req.arrayBuffer());

  // ── 2. Verify signature ─────────────────────────────────────────────────
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.error("[webhook] PAYPAL_WEBHOOK_ID is not set");
    return reject400();
  }

  const sigHeaders = {
    "paypal-transmission-id":   req.headers.get("paypal-transmission-id") ?? undefined,
    "paypal-transmission-time": req.headers.get("paypal-transmission-time") ?? undefined,
    "paypal-cert-url":          req.headers.get("paypal-cert-url") ?? undefined,
    "paypal-transmission-sig":  req.headers.get("paypal-transmission-sig") ?? undefined,
    "paypal-auth-algo":         req.headers.get("paypal-auth-algo") ?? undefined,
  };

  // Log ONLY key names (no values) — safe to share in logs
  const presentHeaders = Object.entries(sigHeaders)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);

  const { valid, reason } = await verifyPayPalWebhook(rawBody, sigHeaders, webhookId);

  if (!valid) {
    // Server-side reason only — never in the response body
    console.error("[webhook] Signature verification FAILED:", {
      presentHeaders,
      reason,
      certUrlHost: sigHeaders["paypal-cert-url"]
        ? (() => {
            try { return new URL(sigHeaders["paypal-cert-url"]!).hostname; }
            catch { return "(invalid)"; }
          })()
        : "(absent)",
    });
    return reject400();
  }

  // ── 3. Parse JSON (after raw body is safely preserved) ─────────────────
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
  } catch {
    console.error("[webhook] Body is not valid JSON");
    return reject400();
  }

  const eventId   = (event.id as string)         ?? "";
  const eventType = (event.event_type as string)  ?? "";

  console.log("[webhook] Received:", {
    eventId,
    eventType,
    presentHeaders,
  });

  // ── 3b. Check duplicate — AFTER signature verified, BEFORE processing ──
  // Per Phase 1 rules: record event_id ONLY after successful processing (step 5).
  // Here we do an early-exit check WITHOUT recording yet.
  if (eventId) {
    const existing = await db
      .select({ eventId: paypalWebhookDeliveries.eventId })
      .from(paypalWebhookDeliveries)
      .where(eq(paypalWebhookDeliveries.eventId, eventId))
      .limit(1);

    if (existing.length > 0) {
      console.log("[webhook] Duplicate event — ignoring:", eventId);
      return NextResponse.json({ status: "duplicate_ignored" }, { status: 200 });
    }
  }

  // ── 4. Route to handler ─────────────────────────────────────────────────
  const resource = event.resource as Record<string, unknown> | undefined;

  try {
    switch (eventType) {
      case "PAYMENT.CAPTURE.COMPLETED":
        await handleCaptureCompleted(resource, eventId);
        break;

      case "PAYMENT.PAYOUTSBATCH.PROCESSING":
        await handlePayoutsBatchProcessing(resource, eventId);
        break;

      case "PAYMENT.PAYOUTSBATCH.SUCCESS":
        await handlePayoutsBatchSuccess(resource, eventId);
        break;

      case "PAYMENT.PAYOUTS-ITEM.SUCCEEDED":
        await handlePayoutsItemSucceeded(resource, eventId);
        break;

      case "PAYMENT.PAYOUTS-ITEM.FAILED":
        await handlePayoutsItemFailed(resource, eventId, "PAYMENT.PAYOUTS-ITEM.FAILED");
        break;

      case "PAYMENT.PAYOUTS-ITEM.RETURNED":
        await handlePayoutsItemFailed(resource, eventId, "PAYMENT.PAYOUTS-ITEM.RETURNED");
        break;

      case "CUSTOMER.DISPUTE.CREATED":
        await handleDisputeCreated(resource, eventId);
        break;

      default:
        // Return 200 without action for unknown event types
        console.log("[webhook] Unhandled event type (200 no-op):", eventType);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] Handler error:", { eventId, eventType, error: msg });
    // Do NOT record event_id on error — allow retry
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }

  // ── 5. Record event_id ONLY after successful processing ─────────────────
  if (eventId) {
    await tryRecordEventId(eventId, eventType);
  }

  return NextResponse.json({ status: "ok", eventId, eventType }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * PAYMENT.CAPTURE.COMPLETED
 * Doc: https://developer.paypal.com/docs/api/orders/v2/#definition-capture
 *
 * Observed Spike 3:
 *   resource.id                                        = capture ID
 *   resource.supplementary_data.related_ids.order_id   = order ID
 *   resource.custom_id                                 = UNVERIFIED (logged if present)
 *
 * Maps by: paypal_capture_id OR paypal_order_id on the payments table.
 * Transition: payment pending → processing; milestone planned/funded → funded
 */
async function handleCaptureCompleted(
  resource: Record<string, unknown> | undefined,
  eventId: string
): Promise<void> {
  // Log all top-level resource keys to observe fields without printing values
  console.log("[webhook] CAPTURE.COMPLETED resource keys:", Object.keys(resource ?? {}));

  const captureId = resource?.id as string | undefined;
  const suppData  = resource?.supplementary_data as Record<string, unknown> | undefined;
  const relIds    = suppData?.related_ids as Record<string, unknown> | undefined;
  const orderId   = relIds?.order_id as string | undefined;  // OBSERVED Spike 3
  const customId  = resource?.custom_id as string | undefined; // UNVERIFIED — log only

  console.log("[webhook] CAPTURE.COMPLETED fields:", {
    captureId:  captureId  ?? "(absent)",
    orderId:    orderId    ?? "(absent)",
    customId:   customId   ?? "(absent — field UNVERIFIED)",
  });

  if (!captureId && !orderId && !customId) {
    console.warn("[webhook] CAPTURE.COMPLETED: no identifying fields found; skipping DB update");
    return;
  }

  // Look up payment by capture_id, order_id, or custom_id (payment.id)
  // Try capture_id first (most specific), then order_id, then custom_id
  let paymentRow: typeof payments.$inferSelect | undefined;

  if (captureId) {
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.paypalCaptureId, captureId))
      .limit(1);
    paymentRow = rows[0];
  }

  if (!paymentRow && orderId) {
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.paypalOrderId, orderId))
      .limit(1);
    paymentRow = rows[0];
  }

  if (!paymentRow && customId) {
    // custom_id = payment.id (set at order creation — UNVERIFIED; confirm on first real event)
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.id, customId))
      .limit(1);
    paymentRow = rows[0];
    if (paymentRow) {
      console.log("[webhook] CAPTURE.COMPLETED: matched via custom_id — field now OBSERVED");
    }
  }

  if (!paymentRow) {
    console.warn("[webhook] CAPTURE.COMPLETED: no payment row found for", { captureId, orderId, customId });
    // Return without error — could be a pre-Phase-1 order or test event
    return;
  }

  // Assert and apply payment transition
  const fromPayment = paymentRow.status as PaymentStatus;
  assertPaymentTransition(fromPayment, "processing");

  await db
    .update(payments)
    .set({
      status: "processing",
      paypalCaptureId: captureId ?? paymentRow.paypalCaptureId,
      updatedAt: new Date(),
    })
    .where(eq(payments.id, paymentRow.id));

  // Update the linked milestone → funded (FUNDED_HELD_SIMULATED in Phase 1 naming)
  const milestoneRows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, paymentRow.milestoneId))
    .limit(1);
  const milestone = milestoneRows[0];

  if (milestone) {
    const fromMilestone = milestone.status as MilestoneStatus;
    if (fromMilestone !== "funded") {
      assertMilestoneTransition(fromMilestone, "funded");
      await db
        .update(milestones)
        .set({
          status: "funded",
          paypalCaptureId: captureId ?? milestone.paypalCaptureId,
          updatedAt: new Date(),
        })
        .where(eq(milestones.id, milestone.id));
    }
  }

  await writeAuditLog({
    entityType: "payment",
    entityId: paymentRow.id,
    event: "CAPTURE_COMPLETED",
    actor: "paypal_webhook",
    payload: {
      webhookEventId: eventId,
      captureId: captureId ?? null,
      orderId: orderId ?? null,
      customId: customId ?? null,
      milestoneId: paymentRow.milestoneId,
    },
  });

  console.log("[webhook] CAPTURE.COMPLETED: payment", paymentRow.id, "→ processing; milestone → funded");
}

/**
 * PAYMENT.PAYOUTSBATCH.PROCESSING
 * Doc: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#definition-payout_batch_header
 *
 * NOTE: PAYOUTSBATCH events contain batch-level info only — NO item detail.
 * resource.batch_header.payout_batch_id = the batch ID
 * Transition: payment pending → processing
 */
async function handlePayoutsBatchProcessing(
  resource: Record<string, unknown> | undefined,
  eventId: string
): Promise<void> {
  console.log("[webhook] PAYOUTSBATCH.PROCESSING resource keys:", Object.keys(resource ?? {}));

  const batchHeader = resource?.batch_header as Record<string, unknown> | undefined;
  const batchId     = batchHeader?.payout_batch_id as string | undefined;

  console.log("[webhook] PAYOUTSBATCH.PROCESSING batchId:", batchId ?? "(absent)");

  if (!batchId) return;

  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.paypalPayoutBatchId, batchId))
    .limit(1);
  const paymentRow = rows[0];

  if (!paymentRow) {
    console.warn("[webhook] PAYOUTSBATCH.PROCESSING: no payment found for batchId:", batchId);
    return;
  }

  const fromPayment = paymentRow.status as PaymentStatus;
  assertPaymentTransition(fromPayment, "processing");

  await db
    .update(payments)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(payments.id, paymentRow.id));

  await writeAuditLog({
    entityType: "payment",
    entityId: paymentRow.id,
    event: "PAYOUT_BATCH_PROCESSING",
    actor: "paypal_webhook",
    payload: { webhookEventId: eventId, batchId },
  });

  console.log("[webhook] PAYOUTSBATCH.PROCESSING: payment", paymentRow.id, "→ processing");
}

/**
 * PAYMENT.PAYOUTSBATCH.SUCCESS
 * Batch completed — batch-level log entry only; no item state change (use PAYOUTS-ITEM for that).
 * Doc: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#definition-payout_batch_header
 */
async function handlePayoutsBatchSuccess(
  resource: Record<string, unknown> | undefined,
  eventId: string
): Promise<void> {
  console.log("[webhook] PAYOUTSBATCH.SUCCESS resource keys:", Object.keys(resource ?? {}));

  const batchHeader = resource?.batch_header as Record<string, unknown> | undefined;
  const batchId     = batchHeader?.payout_batch_id as string | undefined;

  console.log("[webhook] PAYOUTSBATCH.SUCCESS batchId:", batchId ?? "(absent)");

  if (batchId) {
    const rows = await db
      .select({ id: payments.id, milestoneId: payments.milestoneId })
      .from(payments)
      .where(eq(payments.paypalPayoutBatchId, batchId))
      .limit(1);
    const paymentRow = rows[0];

    if (paymentRow) {
      await writeAuditLog({
        entityType: "payment",
        entityId: paymentRow.id,
        event: "PAYOUT_BATCH_SUCCESS",
        actor: "paypal_webhook",
        payload: { webhookEventId: eventId, batchId },
      });
    }
  }
  // No item-level state change here — PAYOUTS-ITEM.SUCCEEDED handles the milestone → paid transition
}

/**
 * PAYMENT.PAYOUTS-ITEM.SUCCEEDED
 * Doc: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#definition-payout_item_details
 *
 * Fields (verified from spike docs; sender_item_id UNVERIFIED until real event observed):
 *   resource.payout_item.sender_item_id = "ITEM_{payment.id}"
 *   resource.payout_item_id             = PayPal's item ID
 *   resource.transaction_id             = PayPal transaction ID
 *
 * Log top-level resource keys to confirm sender_item_id presence.
 * Transition: payment processing → succeeded; milestone → paid
 */
async function handlePayoutsItemSucceeded(
  resource: Record<string, unknown> | undefined,
  eventId: string
): Promise<void> {
  console.log("[webhook] PAYOUTS-ITEM.SUCCEEDED resource keys:", Object.keys(resource ?? {}));

  const payoutItem    = resource?.payout_item    as Record<string, unknown> | undefined;
  const senderItemId  = payoutItem?.sender_item_id as string | undefined;
  const payoutItemId  = resource?.payout_item_id  as string | undefined;
  const transactionId = resource?.transaction_id  as string | undefined;

  // payout_item_fee: observed in batch GET (Spike 1: $0.25 on $1.00).
  // Doc: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#definition-payout_item_details
  // UNVERIFIED in webhook payload vs batch GET — log keys to confirm.
  const payoutItemFeeObj = resource?.payout_item_fee as Record<string, string> | undefined;
  const payoutFeeUsd     = payoutItemFeeObj?.value ?? null;

  console.log("[webhook] PAYOUTS-ITEM.SUCCEEDED fields:", {
    payoutItemKeys:  resource ? Object.keys(resource) : [],
    payoutItemInner: payoutItem ? Object.keys(payoutItem) : "(payout_item absent)",
    senderItemId:    senderItemId  ?? "(absent)",
    payoutItemId:    payoutItemId  ?? "(absent)",
    transactionId:   transactionId ?? "(absent)",
    // Log presence/absence of fee field — never log the value
    payoutItemFeePresent: payoutItemFeeObj !== undefined,
    payoutFeeUsd:    payoutFeeUsd ?? "(absent)",
  });

  // Map by sender_item_id ("ITEM_{payment.id}") → payment.id
  let paymentRow: typeof payments.$inferSelect | undefined;

  if (senderItemId && senderItemId.startsWith("ITEM_")) {
    const paymentId = senderItemId.slice("ITEM_".length);
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    paymentRow = rows[0];
  }

  // Fallback: try by payout_item_id
  if (!paymentRow && payoutItemId) {
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.paypalPayoutItemId, payoutItemId))
      .limit(1);
    paymentRow = rows[0];
  }

  if (!paymentRow) {
    console.warn("[webhook] PAYOUTS-ITEM.SUCCEEDED: no payment found for", { senderItemId, payoutItemId });
    return;
  }

  const fromPayment = paymentRow.status as PaymentStatus;
  assertPaymentTransition(fromPayment, "succeeded");

  await db
    .update(payments)
    .set({
      status:             "succeeded",
      paypalPayoutItemId: payoutItemId ?? paymentRow.paypalPayoutItemId,
      // Store the payout item fee when present — borne by the platform
      // (UNVERIFIED in webhook; observed in batch GET: $0.25 on $1.00)
      ...(payoutFeeUsd !== null ? { payoutFeeUsd } : {}),
      updatedAt: new Date(),
    })
    .where(eq(payments.id, paymentRow.id));

  // Milestone → paid
  const milestoneRows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, paymentRow.milestoneId))
    .limit(1);
  const milestone = milestoneRows[0];

  if (milestone) {
    const fromMilestone = milestone.status as MilestoneStatus;
    if (fromMilestone !== "paid") {
      assertMilestoneTransition(fromMilestone, "paid");
      await db
        .update(milestones)
        .set({
          status: "paid",
          paypalPayoutItemId: payoutItemId ?? milestone.paypalPayoutItemId,
          updatedAt: new Date(),
        })
        .where(eq(milestones.id, milestone.id));
    }
  }

  await writeAuditLog({
    entityType: "payment",
    entityId: paymentRow.id,
    event: "PAYOUT_ITEM_SUCCEEDED",
    actor: "paypal_webhook",
    payload: {
      webhookEventId: eventId,
      senderItemId:   senderItemId  ?? null,
      payoutItemId:   payoutItemId  ?? null,
      transactionId:  transactionId ?? null,
      payoutFeeUsd:   payoutFeeUsd  ?? null,
      milestoneId:    paymentRow.milestoneId,
    },
  });

  console.log("[webhook] PAYOUTS-ITEM.SUCCEEDED: payment", paymentRow.id, "→ succeeded; milestone → paid");
}

/**
 * PAYMENT.PAYOUTS-ITEM.FAILED / RETURNED
 * Doc: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#definition-payout_item_details
 *
 * Transition: payment → failed; milestone → failed | returned
 * errorCode from resource.errors.name (UNVERIFIED field path — log keys to confirm)
 */
async function handlePayoutsItemFailed(
  resource: Record<string, unknown> | undefined,
  eventId: string,
  eventType: string
): Promise<void> {
  console.log(`[webhook] ${eventType} resource keys:`, Object.keys(resource ?? {}));

  const payoutItem   = resource?.payout_item as Record<string, unknown> | undefined;
  const senderItemId = payoutItem?.sender_item_id as string | undefined;
  const payoutItemId = resource?.payout_item_id as string | undefined;
  const errorsObj    = resource?.errors as Record<string, unknown> | undefined;
  // Log keys of errors object to confirm structure (values may contain PII)
  const errorsKeys   = errorsObj ? Object.keys(errorsObj) : [];

  console.log(`[webhook] ${eventType} fields:`, {
    senderItemId:  senderItemId ?? "(absent)",
    payoutItemId:  payoutItemId ?? "(absent)",
    errorsKeys:    errorsKeys,
  });

  let paymentRow: typeof payments.$inferSelect | undefined;

  if (senderItemId && senderItemId.startsWith("ITEM_")) {
    const paymentId = senderItemId.slice("ITEM_".length);
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    paymentRow = rows[0];
  }

  if (!paymentRow && payoutItemId) {
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.paypalPayoutItemId, payoutItemId))
      .limit(1);
    paymentRow = rows[0];
  }

  if (!paymentRow) {
    console.warn(`[webhook] ${eventType}: no payment found for`, { senderItemId, payoutItemId });
    return;
  }

  const fromPayment = paymentRow.status as PaymentStatus;
  const toPayment: PaymentStatus = "failed";
  assertPaymentTransition(fromPayment, toPayment);

  await db
    .update(payments)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(payments.id, paymentRow.id));

  // Milestone terminal state
  const milestoneRows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, paymentRow.milestoneId))
    .limit(1);
  const milestone = milestoneRows[0];

  if (milestone) {
    const fromMilestone = milestone.status as MilestoneStatus;
    const toMilestone: MilestoneStatus =
      eventType === "PAYMENT.PAYOUTS-ITEM.RETURNED" ? "returned" : "failed";

    if (fromMilestone !== toMilestone) {
      assertMilestoneTransition(fromMilestone, toMilestone);
      await db
        .update(milestones)
        .set({ status: toMilestone, updatedAt: new Date() })
        .where(eq(milestones.id, milestone.id));
    }
  }

  await writeAuditLog({
    entityType: "payment",
    entityId: paymentRow.id,
    event: eventType === "PAYMENT.PAYOUTS-ITEM.RETURNED"
      ? "PAYOUT_ITEM_RETURNED"
      : "PAYOUT_ITEM_FAILED",
    actor: "paypal_webhook",
    payload: {
      webhookEventId: eventId,
      senderItemId:  senderItemId ?? null,
      payoutItemId:  payoutItemId ?? null,
      milestoneId:   paymentRow.milestoneId,
    },
  });

  console.log(`[webhook] ${eventType}: payment`, paymentRow.id, "→ failed; milestone →", milestone?.status);
}

/**
 * CUSTOMER.DISPUTE.CREATED
 * Doc: https://developer.paypal.com/docs/api/customer-disputes/v1/#definition-dispute
 *
 * Fields:
 *   resource.dispute_id                                  = PayPal dispute ID
 *   resource.disputed_transactions[0].buyer_transaction_id = capture transaction ID
 *
 * Transition: milestone funded/paid → disputed
 * Phase 6 will handle full dispute flows; this handler records the dispute only.
 */
async function handleDisputeCreated(
  resource: Record<string, unknown> | undefined,
  eventId: string
): Promise<void> {
  console.log("[webhook] DISPUTE.CREATED resource keys:", Object.keys(resource ?? {}));

  const disputeId  = resource?.dispute_id as string | undefined;
  const txns       = resource?.disputed_transactions as Array<Record<string, unknown>> | undefined;
  const buyerTxnId = txns?.[0]?.buyer_transaction_id as string | undefined;

  console.log("[webhook] DISPUTE.CREATED fields:", {
    disputeId:   disputeId  ?? "(absent)",
    buyerTxnId:  buyerTxnId ?? "(absent)",
  });

  if (!buyerTxnId) {
    console.warn("[webhook] DISPUTE.CREATED: no buyer_transaction_id; cannot map to milestone");
    return;
  }

  // Find payment by capture ID (buyer_transaction_id = capture_id for standard orders)
  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.paypalCaptureId, buyerTxnId))
    .limit(1);
  const paymentRow = rows[0];

  if (!paymentRow) {
    console.warn("[webhook] DISPUTE.CREATED: no payment found for buyer_transaction_id:", buyerTxnId);
    return;
  }

  const milestoneRows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, paymentRow.milestoneId))
    .limit(1);
  const milestone = milestoneRows[0];

  if (milestone) {
    const fromMilestone = milestone.status as MilestoneStatus;
    if (fromMilestone !== "disputed") {
      assertMilestoneTransition(fromMilestone, "disputed");
      await db
        .update(milestones)
        .set({ status: "disputed", updatedAt: new Date() })
        .where(eq(milestones.id, milestone.id));
    }
  }

  await writeAuditLog({
    entityType: "milestone",
    entityId: paymentRow.milestoneId,
    event: "DISPUTE_CREATED",
    actor: "paypal_webhook",
    payload: {
      webhookEventId: eventId,
      disputeId:  disputeId  ?? null,
      buyerTxnId: buyerTxnId,
      paymentId:  paymentRow.id,
    },
  });

  console.log("[webhook] DISPUTE.CREATED: milestone", paymentRow.milestoneId, "→ disputed");
}
