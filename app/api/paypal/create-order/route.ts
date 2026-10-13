/**
 * POST /api/paypal/create-order
 *
 * Creates a PayPal Order for a milestone payment.
 * Body: { milestoneId: string }
 *
 * - Reads the milestone's budget_usd from the DB.
 * - Applies FEE_DISPLAY_POLICY to determine the charge amount.
 * - Creates a PayPal Orders v2 request with custom_id = payment.id (for webhook mapping).
 * - Inserts a payments row (status: "pending") before calling PayPal (idempotency).
 * - Returns { id: orderId, paymentId, displayAmount, feeEstimate } to the client.
 *
 * custom_id: set to payment.id at order creation.
 *   Docs say custom_id appears on the capture object:
 *   https://developer.paypal.com/docs/api/orders/v2/#definition-capture
 *   Field path: capture.custom_id (UNVERIFIED in webhook — will confirm from CAPTURE.COMPLETED event log).
 *
 * FEE_DISPLAY_POLICY:
 *   GROSS_ONLY:      charge = milestone budget, no fee shown
 *   SHOW_FEE:        charge = milestone budget; show estimated fee to company before checkout
 *   COMPANY_ABSORBS: charge = milestone budget + estimated_fee; consultant gets full budget
 *
 * Fee estimate: configurable via FEE_ESTIMATE_RATE (default 0.0349) and
 *   FEE_ESTIMATE_FIXED (default 0.49) — observed on $5.00 sandbox tx (Spike 1b).
 *   UNVERIFIED for other amounts/tiers. Reconciled with real fee after capture.
 *
 * Docs:
 *   Orders v2 create:   https://developer.paypal.com/docs/api/orders/v2/#orders_create
 *   custom_id:          https://developer.paypal.com/docs/api/orders/v2/#definition-purchase_unit_request
 *   seller_receivable:  https://developer.paypal.com/docs/api/orders/v2/#definition-seller_receivable_breakdown
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { paypalFetch } from "@/lib/paypal/client";
import { db } from "@/lib/db";
import { milestones, payments } from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

/** Estimated PayPal fee. Observed: 3.49% + $0.49 on $5.00 (Spike 1b — one data point, UNVERIFIED for other amounts). */
const FEE_RATE  = parseFloat(process.env.FEE_ESTIMATE_RATE  ?? "0.0349");
const FEE_FIXED = parseFloat(process.env.FEE_ESTIMATE_FIXED ?? "0.49");

function estimateFee(amount: number): number {
  return Math.round((amount * FEE_RATE + FEE_FIXED) * 100) / 100;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  const milestoneId = body?.milestoneId as string | undefined;

  if (!milestoneId) {
    return NextResponse.json({ error: "milestoneId required" }, { status: 400 });
  }

  // Load milestone
  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, milestoneId))
    .limit(1);

  if (!milestone) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  if (milestone.status !== "planned") {
    return NextResponse.json(
      { error: `Milestone is already ${milestone.status} — cannot fund again` },
      { status: 409 }
    );
  }

  const budgetUsd = parseFloat(milestone.budgetUsd);
  const feePolicy = process.env.FEE_DISPLAY_POLICY ?? "SHOW_FEE";
  const feeEstimate = estimateFee(budgetUsd);

  // COMPANY_ABSORBS: company pays budget + fee so consultant gets full budget
  const chargeAmount =
    feePolicy === "COMPANY_ABSORBS"
      ? Math.round((budgetUsd + feeEstimate) * 100) / 100
      : budgetUsd;

  // Create a payment row BEFORE calling PayPal — idempotency
  const paymentId    = `pmt_${nanoid(12)}`;
  const idemKey      = `order_${nanoid(16)}`;
  const senderBatchId = `PAY_${paymentId}`;

  await db.insert(payments).values({
    id: paymentId,
    milestoneId,
    grossUsd:     chargeAmount.toFixed(2),
    currency:     "USD",
    status:       "pending",
    idempotencyKey: idemKey,
    senderBatchId,
  });

  // Create PayPal order
  // Doc: https://developer.paypal.com/docs/api/orders/v2/#orders_create
  const res = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    idempotencyKey: idemKey,
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: milestoneId,
          description:  `ConsultAI milestone: ${milestone.title}`,
          custom_id:    paymentId,       // used to map CAPTURE.COMPLETED webhook → payment row
          amount: {
            currency_code: "USD",
            value: chargeAmount.toFixed(2),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name:   "ConsultAI",
            landing_page: "NO_PREFERENCE",
            user_action:  "PAY_NOW",
            // return_url / cancel_url not needed for SDK v6 popup flow
          },
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("[create-order] PayPal error:", JSON.stringify(err));
    // Clean up the pending payment row
    await db.delete(payments).where(eq(payments.id, paymentId));
    return NextResponse.json({ error: "PayPal order creation failed", detail: err }, { status: res.status });
  }

  const order = await res.json() as { id: string; status: string };

  // Store the order ID on the payment row
  await db
    .update(payments)
    .set({ paypalOrderId: order.id, updatedAt: new Date() })
    .where(eq(payments.id, paymentId));

  // Also write the order ID to the milestone for quick lookup
  await db
    .update(milestones)
    .set({ paypalOrderId: order.id, updatedAt: new Date() })
    .where(eq(milestones.id, milestoneId));

  await writeAuditLog({
    entityType: "payment",
    entityId:   paymentId,
    event:      "ORDER_CREATED",
    actor:      "system",
    payload:    {
      milestoneId,
      orderId:      order.id,
      chargeAmount: chargeAmount.toFixed(2),
      feeEstimate:  feeEstimate.toFixed(2),
      feePolicy,
    },
  });

  console.log("[create-order] Created:", { orderId: order.id, paymentId, chargeAmount });

  return NextResponse.json({
    id:            order.id,    // orderId — required by SDK v6 createOrder
    paymentId,
    displayAmount: chargeAmount.toFixed(2),
    feeEstimate:   feeEstimate.toFixed(2),
    currency:      "USD",
    feePolicy,
  });
}
