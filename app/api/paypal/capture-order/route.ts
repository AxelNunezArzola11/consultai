/**
 * POST /api/paypal/capture-order
 *
 * Captures an approved PayPal Order and records the fee breakdown.
 * Body: { orderID: string, paymentId: string }
 *
 * - Captures via Orders v2 API.
 * - Reads seller_receivable_breakdown: gross, fee, net, currency.
 * - Updates payments row: gross_usd, fee_usd, net_usd, currency, paypal_capture_id, status → processing.
 * - Updates milestone: capture amounts, status → funded.
 * - Writes audit log entry.
 *
 * NOTE: The webhook PAYMENT.CAPTURE.COMPLETED is the source of truth for state.
 * This route updates the DB optimistically from the browser response. If the webhook
 * arrives first (can happen), the DB is already updated and this is a no-op transition.
 *
 * custom_id: set at order creation to payment.id. Also observed in capture response.
 * Field path: capture.custom_id (confirmed in capture response; UNVERIFIED in webhook — see webhook route).
 *
 * Docs:
 *   Capture order:              https://developer.paypal.com/docs/api/orders/v2/#orders_capture
 *   seller_receivable_breakdown: https://developer.paypal.com/docs/api/orders/v2/#definition-seller_receivable_breakdown
 *     gross_amount.value  = company paid
 *     paypal_fee.value    = PayPal processing fee (Orders; UNVERIFIED fee structure for tiers)
 *     net_amount.value    = platform receives into Business account ("Held" ledger amount)
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { paypalFetch, safeJson } from "@/lib/paypal/client";
import { db } from "@/lib/db";
import { payments, milestones } from "@/lib/db/schema";
import {
  assertMilestoneTransition,
  assertPaymentTransition,
  type MilestoneStatus,
  type PaymentStatus,
} from "@/lib/state-machines/milestone-payment";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
  const body = await req.json().catch(() => null);
  const orderID    = body?.orderID    as string | undefined;
  const paymentId  = body?.paymentId  as string | undefined;

  if (!orderID || !paymentId) {
    return NextResponse.json({ error: "orderID and paymentId required" }, { status: 400 });
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

  // Idempotency: if already captured, return the existing data
  if (paymentRow.status === "processing" || paymentRow.status === "succeeded") {
    return NextResponse.json({
      alreadyCaptured: true,
      captureId: paymentRow.paypalCaptureId,
      grossUsd:  paymentRow.grossUsd,
      feeUsd:    paymentRow.feeUsd,
      netUsd:    paymentRow.netUsd,
      currency:  paymentRow.currency,
    });
  }

  // Capture the order
  // Doc: https://developer.paypal.com/docs/api/orders/v2/#orders_capture
  const res = await paypalFetch(`/v2/checkout/orders/${orderID}/capture`, {
    method: "POST",
    idempotencyKey: `capture_${paymentId}`,
  });

  // Use safeJson: PayPal may return empty body on some error codes
  const captureData = await safeJson(res);

  if (!res.ok) {
    console.error("[capture-order] PayPal error HTTP", res.status, JSON.stringify(captureData));
    return NextResponse.json({ error: "Capture failed", detail: captureData }, { status: res.status });
  }

  // Extract first capture from first purchase unit
  // Doc: https://developer.paypal.com/docs/api/orders/v2/#definition-order
  const purchaseUnits = captureData.purchase_units as Array<Record<string, unknown>> | undefined;
  const firstCapture  = purchaseUnits?.[0]?.payments as Record<string, unknown> | undefined;
  const captures      = firstCapture?.captures as Array<Record<string, unknown>> | undefined;
  const capture       = captures?.[0];

  if (!capture) {
    console.error("[capture-order] No capture object in response:", JSON.stringify(captureData));
    return NextResponse.json({ error: "No capture in response" }, { status: 500 });
  }

  const captureId     = capture.id as string;
  const captureStatus = capture.status as string;
  const customId      = capture.custom_id as string | undefined; // payment.id — confirm path here

  console.log("[capture-order] capture keys:", Object.keys(capture));
  console.log("[capture-order] capture.custom_id present:", customId !== undefined, "— field now OBSERVED");

  // seller_receivable_breakdown
  // Doc: https://developer.paypal.com/docs/api/orders/v2/#definition-seller_receivable_breakdown
  const breakdown = capture.seller_receivable_breakdown as Record<string, unknown> | undefined;
  const grossUsd  = (breakdown?.gross_amount  as Record<string, string> | undefined)?.value;
  const feeUsd    = (breakdown?.paypal_fee    as Record<string, string> | undefined)?.value;
  const netUsd    = (breakdown?.net_amount    as Record<string, string> | undefined)?.value;
  const currency  = (breakdown?.gross_amount  as Record<string, string> | undefined)?.currency_code ?? "USD";

  console.log("[capture-order] fee breakdown:", {
    grossUsd: grossUsd ?? "(absent)",
    feeUsd:   feeUsd   ?? "(absent)",
    netUsd:   netUsd   ?? "(absent)",
    currency,
    captureId,
    captureStatus,
  });

  // Update payment row
  const fromPayment = paymentRow.status as PaymentStatus;
  assertPaymentTransition(fromPayment, "processing");

  await db
    .update(payments)
    .set({
      status:          "processing",
      paypalOrderId:   orderID,
      paypalCaptureId: captureId,
      grossUsd:        grossUsd ?? paymentRow.grossUsd,
      feeUsd:          feeUsd   ?? null,
      netUsd:          netUsd   ?? null,
      currency,
      updatedAt:       new Date(),
    })
    .where(eq(payments.id, paymentId));

  // Update milestone → funded (FUNDED_HELD_SIMULATED)
  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, paymentRow.milestoneId))
    .limit(1);

  if (milestone) {
    const fromMilestone = milestone.status as MilestoneStatus;
    if (fromMilestone !== "funded") {
      assertMilestoneTransition(fromMilestone, "funded");
      await db
        .update(milestones)
        .set({
          status:           "funded",
          paypalOrderId:    orderID,
          paypalCaptureId:  captureId,
          captureGrossUsd:  grossUsd ?? null,
          captureFeeUsd:    feeUsd   ?? null,
          captureNetUsd:    netUsd   ?? null,
          currency,
          updatedAt:        new Date(),
        })
        .where(eq(milestones.id, milestone.id));
    }
  }

  await writeAuditLog({
    entityType: "payment",
    entityId:   paymentId,
    event:      "CAPTURE_COMPLETED_BROWSER",
    actor:      "company",
    payload:    {
      orderId:    orderID,
      captureId,
      captureStatus,
      grossUsd:   grossUsd ?? null,
      feeUsd:     feeUsd   ?? null,
      netUsd:     netUsd   ?? null,
      currency,
      customId:   customId ?? null,
      milestoneId: paymentRow.milestoneId,
      note: "Browser capture response — webhook CAPTURE.COMPLETED is source of truth",
    },
  });

  return NextResponse.json({
    orderId:       orderID,
    orderStatus:   captureData.status,
    captureId,
    captureStatus,
    grossUsd:      grossUsd   ?? null,
    feeUsd:        feeUsd     ?? null,
    netUsd:        netUsd     ?? null,
    currency,
    paymentId,
    milestoneId:   paymentRow.milestoneId,
  });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[capture-order] Unexpected error:", message);
    return NextResponse.json({ error: "Internal server error", detail: message }, { status: 500 });
  }
}
