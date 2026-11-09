/**
 * POST /api/paypal/dispute/provide-evidence
 *
 * Server-side route called ONLY after human approval in DisputeView.
 * Submits evidence for a dispute to PayPal Disputes REST API.
 *
 * IMPORTANT: This route must NEVER be called automatically.
 * The DisputeAgent proposes evidence; the human approves; this route executes.
 *
 * UNVERIFIED: PayPal provide-evidence endpoint not yet called in sandbox.
 * See lib/paypal/dispute-tools.ts for status notes.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { provideDisputeEvidence } from "@/lib/paypal/dispute-tools";
import { db } from "@/lib/db";
import { disputes, milestones, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";
import { demoBlocked } from "@/lib/demo/guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  disputeRowId: z.string().min(1),
  paypalDisputeId: z.string().min(1),
  evidenceList: z.array(
    z.object({
      evidence_type: z.string().min(1),
      notes: z.string().optional(),
      documents: z
        .array(z.object({ name: z.string(), url: z.string().url() }))
        .optional(),
    })
  ).min(1),
  note: z.string().min(1).max(2000),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return demoBlocked("PayPal dispute evidence submission");
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

  // ── Rate limit: 10 evidence submissions per IP per 60 s ───────────────────
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("dispute-evidence", ip, 10, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  const { disputeRowId, paypalDisputeId, evidenceList, note } = body;

  // Verify dispute row exists and belongs to this system
  const rows = await db
    .select({
      id: disputes.id,
      evidenceStatus: disputes.evidenceStatus,
      milestoneId: disputes.milestoneId,
      paypalDisputeId: disputes.paypalDisputeId,
    })
    .from(disputes)
    .where(eq(disputes.id, disputeRowId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "dispute not found" }, { status: 404 });
  }

  // Bind the submitted PayPal dispute ID to the stored row so a caller cannot
  // act on a foreign PayPal dispute through this row.
  if (rows[0].paypalDisputeId && rows[0].paypalDisputeId !== paypalDisputeId) {
    return NextResponse.json({ error: "paypalDisputeId does not match dispute" }, { status: 400 });
  }

  if (session?.role === "company" && session.companyId && rows[0].milestoneId) {
    const [milestone] = await db
      .select({ projectId: milestones.projectId })
      .from(milestones)
      .where(eq(milestones.id, rows[0].milestoneId))
      .limit(1);
    const [project] = milestone
      ? await db
          .select({ companyId: projects.companyId })
          .from(projects)
          .where(eq(projects.id, milestone.projectId))
          .limit(1)
      : [];
    if (!milestone || !project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (rows[0].evidenceStatus === "submitted") {
    return NextResponse.json(
      { error: "evidence already submitted", evidenceStatus: "submitted" },
      { status: 409 }
    );
  }

  const result = await provideDisputeEvidence(
    disputeRowId,
    paypalDisputeId,
    evidenceList,
    note
  );

  if (!result.success) {
    return NextResponse.json(
      { error: result.error, httpStatus: result.httpStatus },
      { status: 502 }
    );
  }

  return NextResponse.json({ status: "ok", httpStatus: result.httpStatus });
}
