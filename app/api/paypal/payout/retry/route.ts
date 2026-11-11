/**
 * POST /api/paypal/payout/retry
 *
 * Re-issues a payout whose previous attempt failed at PayPal
 * (PAYOUTS-ITEM.FAILED / PAYOUTSBATCH.DENIED|FAILED webhook → payment
 * `failed`, milestone `failed`).
 *
 * Body: { paymentId: string, recipientEmail: string, note?: string }
 *
 * Why a NEW payment row per attempt:
 *   PayPal's sender_batch_id is unique per batch (re-submitting the failed
 *   batch id returns a duplicate error), and sender_item_id maps webhooks
 *   back via "ITEM_{payment.id}". A fresh row gets fresh deterministic ids
 *   (PAY_retry_* / ITEM_{newId}) so the retry can't collide with the failed
 *   attempt and its webhook maps to the right row. The failed row is kept
 *   untouched as the audit trail.
 *
 * State walk (all transitions pre-approved by the state machines):
 *   new payment row is INSERTED as `processing` — funds are still held from
 *   the original capture (order/capture ids + ledger are copied over).
 *   milestone `failed|returned` → `planned` → `funded`, clearing the stale
 *   payout batch/item ids. executeDirectPayout then runs the normal
 *   threshold approval gate and moves toward `verifying`.
 *
 * Auth: company/admin role; company sessions are scoped to their own
 * company's projects. Rate-limited (10 attempts per IP per 60 s).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { payments, milestones, projects } from "@/lib/db/schema";
import { executeDirectPayout } from "@/lib/payments/direct-payout";
import {
  assertMilestoneTransition,
  type MilestoneStatus,
} from "@/lib/state-machines/milestone-payment";
import { writeAuditLog } from "@/lib/db/audit";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";
import { demoBlocked } from "@/lib/demo/guard";

export const dynamic = "force-dynamic";

const RETRIABLE_PAYMENT_STATUSES = ["failed", "returned"] as const;
const RETRIABLE_MILESTONE_STATUSES = ["failed", "returned"] as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return demoBlocked("PayPal payout retry");

  // ── Auth: require role=company or role=admin ────────────────────────────
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden: company or admin role required" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  // ── Rate limit: 10 retries per IP per 60 s ──────────────────────────────
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("payout-retry", ip, 10, 60);
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

    // ── Load the failed payment ───────────────────────────────────────────
    const [paymentRow] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);

    if (!paymentRow) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (!(RETRIABLE_PAYMENT_STATUSES as readonly string[]).includes(paymentRow.status)) {
      return NextResponse.json(
        { error: `Payment status is '${paymentRow.status}' — only 'failed' or 'returned' payments can be retried` },
        { status: 409 }
      );
    }

    // ── Load the milestone ────────────────────────────────────────────────
    const [milestone] = await db
      .select()
      .from(milestones)
      .where(eq(milestones.id, paymentRow.milestoneId))
      .limit(1);

    if (!milestone) {
      return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
    }

    if (!(RETRIABLE_MILESTONE_STATUSES as readonly string[]).includes(milestone.status)) {
      return NextResponse.json(
        { error: `Milestone status is '${milestone.status}' — only 'failed' or 'returned' milestones can be retried` },
        { status: 409 }
      );
    }

    // ── Company scoping ───────────────────────────────────────────────────
    if (session?.role === "company" && session.companyId) {
      const [project] = await db
        .select({ companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, milestone.projectId))
        .limit(1);
      if (!project || project.companyId !== session.companyId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    if (!paymentRow.netUsd) {
      return NextResponse.json(
        { error: "Payment has no net_usd — capture may not have completed" },
        { status: 409 }
      );
    }

    // ── Create the retry attempt row (fresh PayPal ids, funds still held) ──
    const retryPaymentId = `pay_retry_${nanoid(12)}`;
    const retrySenderBatchId = `PAY_retry_${nanoid(12)}`;

    await db.insert(payments).values({
      id: retryPaymentId,
      milestoneId: paymentRow.milestoneId,
      candidateId: paymentRow.candidateId,
      grossUsd: paymentRow.grossUsd,
      feeUsd: paymentRow.feeUsd,
      netUsd: paymentRow.netUsd,
      currency: paymentRow.currency,
      paypalOrderId: paymentRow.paypalOrderId,
      paypalCaptureId: paymentRow.paypalCaptureId,
      senderBatchId: retrySenderBatchId,
      status: "processing",
      justification:
        `Retry of ${paymentRow.id} after payout ${paymentRow.status}` +
        (paymentRow.payoutFailureReason ? `: ${paymentRow.payoutFailureReason}` : ""),
    });

    // ── Reset the milestone to funded (held) via allowed transitions ──────
    // failed|returned → planned → funded. Stale payout ids from the failed
    // attempt are cleared; executeDirectPayout records the new batch id.
    const fromMs = milestone.status as MilestoneStatus;
    assertMilestoneTransition(fromMs, "planned");
    assertMilestoneTransition("planned", "funded");
    await db
      .update(milestones)
      .set({
        status: "funded",
        paypalPayoutBatchId: null,
        paypalPayoutItemId: null,
        updatedAt: new Date(),
      })
      .where(eq(milestones.id, milestone.id));

    const actor = session ? `${session.role}:${session.userId}` : role;
    await writeAuditLog({
      entityType: "payment",
      entityId: retryPaymentId,
      event: "PAYOUT_RETRY_INITIATED",
      actor,
      payload: {
        originalPaymentId: paymentRow.id,
        milestoneId: paymentRow.milestoneId,
        failureReason: paymentRow.payoutFailureReason ?? null,
        recipientEmail,
        senderBatchId: retrySenderBatchId,
      },
    });

    // ── Issue the payout through the normal approval gate ─────────────────
    const payoutResult = await executeDirectPayout({
      paymentId: retryPaymentId,
      recipientEmail,
      note: note || `Retry of ${paymentRow.id}`,
      bypass_approval: false,
    });

    if (payoutResult.error) {
      return NextResponse.json(
        {
          error: payoutResult.error,
          retryPaymentId,
          originalPaymentId: paymentRow.id,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ...payoutResult,
      retryPaymentId,
      originalPaymentId: paymentRow.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[payout/retry] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
