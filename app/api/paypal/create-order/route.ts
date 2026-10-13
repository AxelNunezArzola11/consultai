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
 * custom_id is set on the purchase_unit so it appears on the capture object.
 * Doc: https://developer.paypal.com/docs/api/orders/v2/#definition-purchase_unit_request
 * Observed: custom_id present in capture response (confirmed Step 3).
 * UNVERIFIED in CAPTURE.COMPLETED webhook — will confirm from event log keys.
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
 * NOTE on payment_source: NOT included here. The payment_source.paypal field is only
 * required for Hosted Fields (card payments without redirect). For the SDK v6 popup
 * flow, the buyer selects their payment method in the PayPal popup — no payment_source
 * needed on the server-side order creation.
 * Doc: https://developer.paypal.com/docs/api/orders/v2/#orders_create
 *
 * Docs:
 *   Orders v2 create:   https://developer.paypal.com/docs/api/orders/v2/#orders_create
 *   custom_id:          https://developer.paypal.com/docs/api/orders/v2/#definition-purchase_unit_request
 *   seller_receivable:  https://developer.paypal.com/docs/api/orders/v2/#definition-seller_receivable_breakdown
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { paypalFetch, safeJson } from "@/lib/paypal/client";
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
  try {
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

    const budgetUsd   = parseFloat(milestone.budgetUsd);
    const feePolicy   = process.env.FEE_DISPLAY_POLICY ?? "SHOW_FEE";
    const feeEstimate = estimateFee(budgetUsd);

    // COMPANY_ABSORBS: company pays budget + fee so consultant gets full budget
    const chargeAmount =
      feePolicy === "COMPANY_ABSORBS"
        ? Math.round((budgetUsd + feeEstimate) * 100) / 100
        : budgetUsd;

    // Create a payment row BEFORE calling PayPal — idempotency
    const paymentId     = `pmt_${nanoid(12)}`;
    const idemKey       = `order_${nanoid(16)}`;
    const senderBatchId = `PAY_${paymentId}`;

    await db.insert(payments).values({
      id:             paymentId,
      milestoneId,
      grossUsd:       chargeAmount.toFixed(2),
      currency:       "USD",
      status:         "pending",
      idempotencyKey: idemKey,
      senderBatchId,
    });

    // Create PayPal order
    // Doc: https://developer.paypal.com/docs/api/orders/v2/#orders_create
    // NOTE: No payment_source field — the SDK v6 popup handles buyer payment method selection.
    const res = await paypalFetch("/v2/checkout/orders", {
      method:         "POST",
      idempotencyKey: idemKey,
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: milestoneId,
            description:  `ConsultAI milestone: ${milestone.title}`,
            custom_id:    paymentId,   // maps CAPTURE.COMPLETED webhook → payment row
            amount: {
              currency_code: "USD",
              value:         chargeAmount.toFixed(2),
            },
          },
        ],
      }),
    });

    const orderData = await safeJson(res);

    if (!res.ok) {
      console.error("[create-order] PayPal error HTTP", res.status, JSON.stringify(orderData));
      // Clean up the pending payment row so the user can retry
      await db.delete(payments).where(eq(payments.id, paymentId));
      return NextResponse.json(
        { error: "PayPal order creation failed", detail: orderData },
        { status: res.status }
      );
    }

    const orderId = orderData.id as string;

    // Store the order ID on the payment row
    await db
      .update(payments)
      .set({ paypalOrderId: orderId, updatedAt: new Date() })
      .where(eq(payments.id, paymentId));

    // Also write the order ID to the milestone for quick lookup
    await db
      .update(milestones)
      .set({ paypalOrderId: orderId, updatedAt: new Date() })
      .where(eq(milestones.id, milestoneId));

    await writeAuditLog({
      entityType: "payment",
      entityId:   paymentId,
      event:      "ORDER_CREATED",
      actor:      "system",
      payload: {
        milestoneId,
        orderId,
        chargeAmount: chargeAmount.toFixed(2),
        feeEstimate:  feeEstimate.toFixed(2),
        feePolicy,
      },
    });

    console.log("[create-order] Created:", { orderId, paymentId, chargeAmount });

    return NextResponse.json({
      id:            orderId,   // orderId — required by SDK v6 createOrder
      paymentId,
      displayAmount: chargeAmount.toFixed(2),
      feeEstimate:   feeEstimate.toFixed(2),
      currency:      "USD",
      feePolicy,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[create-order] Unexpected error:", message);
    return NextResponse.json({ error: "Internal server error", detail: message }, { status: 500 });
  }
}
