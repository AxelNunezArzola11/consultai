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
 *   Permanently disabled per Section 5. Any bypass_approval value in the body is
 *   ignored (forced to false); every payout goes through the approval gate and
 *   reaches `paid` only via PayPal webhook confirmation.
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
import { db } from "@/lib/db";
import { payments, milestones, projects } from "@/lib/db/schema";
import { executeDirectPayout } from "@/lib/payments/direct-payout";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";
import { demoBlocked } from "@/lib/demo/guard";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return demoBlocked("PayPal payouts");
  // ── Auth: require role=company or role=admin cookie ───────────────────────
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden: company or admin role required" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
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
    // Section 5 Security Enforcement: Never allow bypass_approval to skip human authorization gates.
    const bypass_approval = false;

    if (!paymentId || typeof paymentId !== "string" || paymentId.length > 100 ||
        !recipientEmail || typeof recipientEmail !== "string" || recipientEmail.length > 320 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return NextResponse.json(
        { error: "paymentId and recipientEmail required" },
        { status: 400 }
      );
    }
    if (typeof note !== "string" || note.length > 2000) {
      return NextResponse.json({ error: "invalid note" }, { status: 400 });
    }

    if (session?.role === "company" && session.companyId) {
      const [payment] = await db
        .select({ milestoneId: payments.milestoneId })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
      const [milestone] = payment?.milestoneId
        ? await db
            .select({ projectId: milestones.projectId })
            .from(milestones)
            .where(eq(milestones.id, payment.milestoneId))
            .limit(1)
        : [];
      const [project] = milestone
        ? await db
            .select({ companyId: projects.companyId })
            .from(projects)
            .where(eq(projects.id, milestone.projectId))
            .limit(1)
        : [];
      if (!payment || !milestone || !project || project.companyId !== session.companyId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
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
