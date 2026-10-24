/**
 * GET /api/milestone-status/[milestoneId]
 *
 * Returns the current status of a milestone plus its most recent audit log entries.
 * Used by the money-flow UI for polling (every 2-3 s).
 *
 * No authentication in Phase 1 — assumes single-tenant demo.
 *
 * Response shape:
 * {
 *   milestoneId: string
 *   status: MilestoneStatus
 *   captureGrossUsd: string | null
 *   captureFeeUsd: string | null
 *   captureNetUsd: string | null
 *   currency: string | null
 *   paypalOrderId: string | null
 *   paypalCaptureId: string | null
 *   paypalPayoutBatchId: string | null
 *   payment: { id, status, grossUsd, feeUsd, netUsd, payoutFeeUsd } | null
 *   audit: { id, event, actor, createdAt, payload }[]
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { milestones, payments, auditLog } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ milestoneId: string }> }
): Promise<NextResponse> {
  const { milestoneId } = await params;

  const rows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, milestoneId))
    .limit(1);

  const milestone = rows[0];
  if (!milestone) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Latest payment for this milestone
  const paymentRows = await db
    .select({
      id:          payments.id,
      status:      payments.status,
      grossUsd:    payments.grossUsd,
      feeUsd:      payments.feeUsd,
      netUsd:      payments.netUsd,
      payoutFeeUsd: payments.payoutFeeUsd,
    })
    .from(payments)
    .where(eq(payments.milestoneId, milestoneId))
    .limit(1);

  // Last 20 audit entries for this milestone
  const auditRows = await db
    .select({
      id:        auditLog.id,
      event:     auditLog.event,
      actor:     auditLog.actor,
      createdAt: auditLog.createdAt,
      payload:   auditLog.payload,
    })
    .from(auditLog)
    .where(eq(auditLog.entityId, milestoneId))
    .orderBy(desc(auditLog.createdAt))
    .limit(20);

  return NextResponse.json({
    milestoneId:         milestone.id,
    status:              milestone.status,
    captureGrossUsd:     milestone.captureGrossUsd,
    captureFeeUsd:       milestone.captureFeeUsd,
    captureNetUsd:       milestone.captureNetUsd,
    currency:            milestone.currency,
    paypalOrderId:       milestone.paypalOrderId,
    paypalCaptureId:     milestone.paypalCaptureId,
    paypalPayoutBatchId: milestone.paypalPayoutBatchId,
    payment:             paymentRows[0] ?? null,
    audit:               auditRows.map((a) => ({
      id:        String(a.id),
      event:     a.event,
      actor:     a.actor,
      createdAt: a.createdAt.toISOString(),
      payload:   a.payload ?? null,
    })),
  });
}
