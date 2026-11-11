/**
 * GET /api/milestone-status/[milestoneId]
 *
 * Returns the current status of a milestone plus its most recent audit log entries.
 * Used by the money-flow UI for polling (every 2-3 s).
 *
 * Auth: company/admin role required; company sessions are scoped to their
 * own company's projects (cross-company milestone IDs return 403).
 * Rate-limited (poll endpoint).
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
 *   payment: { id, status, grossUsd, feeUsd, netUsd, payoutFeeUsd, payoutFailureReason } | null
 *   audit: { id, event, actor, createdAt, payload }[]
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { milestones, payments, auditLog, projects } from "@/lib/db/schema";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ milestoneId: string }> }
): Promise<NextResponse> {
  const { milestoneId } = await params;

  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("milestone-status", ip, 120, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  if (isDemoMode()) {
    const t = getDemoTables();
    const milestone = t.milestones.find((m) => m.id === milestoneId);
    if (!milestone) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const demoProject = t.projects.find((p) => p.id === milestone.projectId);
    if (
      session?.role === "company" &&
      session.companyId &&
      demoProject?.companyId !== session.companyId
    ) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const payment = t.payments.find((p) => p.milestoneId === milestoneId) ?? null;
    const audit = t.auditLog
      .filter((a) => a.entityId === milestoneId)
      .sort((a, b) => +b.createdAt - +a.createdAt)
      .slice(0, 20)
      .map((a) => ({
        id: String(a.id),
        event: a.event,
        actor: a.actor,
        createdAt: a.createdAt.toISOString(),
        payload: a.payload ?? null,
      }));
    return NextResponse.json({
      milestoneId: milestone.id,
      status: milestone.status,
      captureGrossUsd: milestone.captureGrossUsd,
      captureFeeUsd: milestone.captureFeeUsd,
      captureNetUsd: milestone.captureNetUsd,
      currency: milestone.currency,
      paypalOrderId: milestone.paypalOrderId,
      paypalCaptureId: milestone.paypalCaptureId,
      paypalPayoutBatchId: milestone.paypalPayoutBatchId,
      payment: payment
        ? {
            id: payment.id,
            status: payment.status,
            grossUsd: payment.grossUsd,
            feeUsd: payment.feeUsd,
            netUsd: payment.netUsd,
            payoutFeeUsd: payment.payoutFeeUsd,
            payoutFailureReason: payment.payoutFailureReason,
          }
        : null,
      audit,
    });
  }

  const rows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, milestoneId))
    .limit(1);

  const milestone = rows[0];
  if (!milestone) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (session?.role === "company" && session.companyId) {
    const [project] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, milestone.projectId))
      .limit(1);
    if (!project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  // Latest payment for this milestone (a retry leaves the failed row
  // behind, so newest-first keeps the panel on the current attempt).
  const paymentRows = await db
    .select({
      id:          payments.id,
      status:      payments.status,
      grossUsd:    payments.grossUsd,
      feeUsd:      payments.feeUsd,
      netUsd:      payments.netUsd,
      payoutFeeUsd: payments.payoutFeeUsd,
      payoutFailureReason: payments.payoutFailureReason,
    })
    .from(payments)
    .where(eq(payments.milestoneId, milestoneId))
    .orderBy(desc(payments.createdAt))
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
