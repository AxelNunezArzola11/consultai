/**
 * POST /api/paypal/payout
 *
 * Issues a PayPal Payout to a freelancer (recipient_type: EMAIL).
 * Body: { paymentId: string, recipientEmail: string, note?: string, bypass_approval?: boolean }
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
 * bypass_approval flag:
 *   When bypass_approval: true is included in the body, the approval gate and threshold
 *   check are skipped entirely. The payout is issued immediately via PayPal Sandbox
 *   without creating an approval record. Intended for chat-triggered payouts.
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
import { executeDirectPayout } from "@/lib/payments/direct-payout";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: require role=company cookie ─────────────────────────────────────
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company") {
    return NextResponse.json({ error: "Forbidden: company role required" }, { status: 403 });
  }

  // ── Rate limit: 20 payout attempts per IP per 60 s ────────────────────────
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("payout", ip, 20, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  try {
    const body           = await req.json().catch(() => null);
    const paymentId      = body?.paymentId      as string | undefined;
    const recipientEmail = body?.recipientEmail as string | undefined;
    const note           = (body?.note          as string | undefined) ?? "";
    const bypass_approval = body?.bypass_approval === true;

    if (!paymentId || !recipientEmail) {
      return NextResponse.json(
        { error: "paymentId and recipientEmail required" },
        { status: 400 }
      );
    }

    const payoutResult = await executeDirectPayout({
      paymentId,
      recipientEmail,
      note,
      bypass_approval,
    });

    if (payoutResult.error) {
      if (payoutResult.error.includes("not found")) {
        return NextResponse.json({ error: payoutResult.error }, { status: 404 });
      }
      if (payoutResult.error.includes("status is")) {
        return NextResponse.json({ error: payoutResult.error }, { status: 409 });
      }
      if (payoutResult.error.includes("net_usd")) {
        return NextResponse.json({ error: payoutResult.error }, { status: 409 });
      }
      if (payoutResult.status === "rejected") {
        return NextResponse.json(
          { error: payoutResult.error, approvalId: payoutResult.approvalId },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: payoutResult.error }, { status: 500 });
    }

    return NextResponse.json(payoutResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[payout] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
