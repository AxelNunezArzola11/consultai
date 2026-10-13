/**
 * POST /api/paypal/payout/approve
 *
 * Approves a pending payout and immediately issues it.
 * Body: { approvalId: string, recipientEmail: string, note?: string }
 *
 * This is the "Approve" button action from the approvals page.
 * On approval, it re-calls the payout issuance logic directly
 * (same deterministic IDs — idempotent by design).
 *
 * Docs:
 *   Same as /api/paypal/payout — payouts batch API.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { paypalFetch, safeJson, getAccessToken } from "@/lib/paypal/client";
import { db } from "@/lib/db";
import { approvals, payments, milestones } from "@/lib/db/schema";
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
    const body           = await req.json().catch(() => null);
    const approvalId     = body?.approvalId     as string | undefined;
    const recipientEmail = body?.recipientEmail as string | undefined;
    const note           = (body?.note          as string | undefined) ?? "";

    if (!approvalId || !recipientEmail) {
      return NextResponse.json(
        { error: "approvalId and recipientEmail required" },
        { status: 400 }
      );
    }

    // Load approval
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);

    if (!approval) {
      return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }
    if (approval.decision !== "pending") {
      return NextResponse.json(
        { error: `Approval is already '${approval.decision}'` },
        { status: 409 }
      );
    }

    // Load payment
    const [paymentRow] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, approval.paymentId))
      .limit(1);

    if (!paymentRow) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    const netUsd = paymentRow.netUsd;
    if (!netUsd) {
      return NextResponse.json(
        { error: "Payment has no net_usd — capture may not have completed" },
        { status: 409 }
      );
    }
    const amountUsd    = parseFloat(netUsd).toFixed(2);
    const senderBatchId = paymentRow.senderBatchId ?? `PAY_${paymentRow.id}`;
    const senderItemId  = `ITEM_${paymentRow.id}`;

    // Issue the payout
    const res = await paypalFetch("/v1/payments/payouts", {
      method: "POST",
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          email_subject:   "ConsultAI — milestone payment (approved)",
          email_message:   note || "Your approved milestone payment from ConsultAI.",
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: amountUsd, currency: "USD" },
            note:           note || "Approved milestone payment",
            sender_item_id: senderItemId,
            receiver:       recipientEmail,
          },
        ],
      }),
    });

    const data = await safeJson(res);

    // Check for idempotent duplicate (payment already issued)
    let batchId: string;
    let batchStatus: string;
    let isReplay = false;

    if (res.status === 201) {
      const header = data.batch_header as Record<string, unknown> | undefined;
      batchId     = (header?.payout_batch_id as string) ?? "";
      batchStatus = (header?.batch_status    as string) ?? "PENDING";
    } else if (res.status === 400) {
      const details = data.details as Array<Record<string, string>> | undefined;
      if (details?.some((d) => d.field === "SENDER_BATCH_ID")) {
        // Already issued — replay
        const links    = data.links as Array<Record<string, string>> | undefined;
        const selfLink = links?.find((l) => l.rel === "self")?.href;
        isReplay = true;

        if (selfLink) {
          const token  = await getAccessToken();
          const getRes = await fetch(selfLink, {
            headers: { Authorization: `Bearer ${token}` },
            cache:   "no-store",
          });
          const getJson  = await safeJson(getRes);
          const header   = getJson.batch_header as Record<string, unknown> | undefined;
          batchId        = (header?.payout_batch_id as string) ?? "";
          batchStatus    = (header?.batch_status    as string) ?? "UNKNOWN";
        } else {
          batchId = senderBatchId;
          batchStatus = "REPLAY_NO_LINK";
        }
      } else {
        throw new Error(`Payout failed HTTP 400: ${JSON.stringify(data)}`);
      }
    } else {
      throw new Error(`Payout failed HTTP ${res.status}: ${JSON.stringify(data)}`);
    }

    // Mark approval as approved
    await db
      .update(approvals)
      .set({
        decision:  "approved",
        decidedBy: "company",
        decidedAt: new Date(),
        notes:     note || null,
      })
      .where(eq(approvals.id, approvalId));

    // Payment → processing
    const fromPayment = paymentRow.status as PaymentStatus;
    if (fromPayment !== "processing") {
      assertPaymentTransition(fromPayment, "processing");
      await db
        .update(payments)
        .set({
          paypalPayoutBatchId: batchId,
          status:              "processing",
          updatedAt:           new Date(),
        })
        .where(eq(payments.id, paymentRow.id));
    }

    // Milestone → verifying
    const [milestone] = await db
      .select()
      .from(milestones)
      .where(eq(milestones.id, paymentRow.milestoneId))
      .limit(1);

    if (milestone && milestone.status !== "verifying") {
      const fromMs = milestone.status as MilestoneStatus;
      assertMilestoneTransition(fromMs, "verifying");
      await db
        .update(milestones)
        .set({
          paypalPayoutBatchId: batchId,
          status:              "verifying",
          updatedAt:           new Date(),
        })
        .where(eq(milestones.id, milestone.id));
    }

    await writeAuditLog({
      entityType: "payment",
      entityId:   paymentRow.id,
      event:      isReplay ? "PAYOUT_APPROVE_REPLAY" : "PAYOUT_APPROVED_ISSUED",
      actor:      "company",
      payload: {
        approvalId,
        batchId,
        batchStatus,
        senderBatchId,
        senderItemId,
        recipientEmail,
        amountUsd,
        isReplay,
      },
    });

    return NextResponse.json({
      status:      "ok",
      isReplay,
      approvalId,
      batchId,
      batchStatus,
      amountUsd,
      message: isReplay
        ? "Idempotent replay — payout already issued"
        : `Payout approved and issued — batch ${batchId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[payout/approve] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
