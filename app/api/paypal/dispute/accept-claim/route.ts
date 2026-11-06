/**
 * POST /api/paypal/dispute/accept-claim
 *
 * Server-side route called ONLY after explicit human approval.
 * Accepts a dispute claim — the merchant concedes.
 * When accepted, PayPal automatically refunds the buyer from the merchant account.
 *
 * IMPORTANT: This is an irreversible financial action.
 * It must NEVER be called automatically.
 * The human must explicitly click "Accept Claim" in DisputeView.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { acceptDisputeClaim } from "@/lib/paypal/dispute-tools";
import { db } from "@/lib/db";
import { disputes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";
import { demoBlocked } from "@/lib/demo/guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  disputeRowId: z.string().min(1),
  paypalDisputeId: z.string().min(1),
  note: z.string().min(1).max(2000),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return demoBlocked("PayPal dispute claim acceptance");
  // ── Auth: require role=company or role=admin cookie ───────────────────────
  // This is an irreversible financial action (PayPal auto-refunds the buyer).
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden: company or admin role required" }, { status: 403 });
  }

  // ── Rate limit: 10 claim acceptances per IP per 60 s ──────────────────────
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("dispute-accept", ip, 10, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  const { disputeRowId, paypalDisputeId, note } = body;

  // Verify dispute row exists and is still open
  const rows = await db
    .select({ id: disputes.id, status: disputes.status, resolutionOutcome: disputes.resolutionOutcome })
    .from(disputes)
    .where(eq(disputes.id, disputeRowId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "dispute not found" }, { status: 404 });
  }

  if (rows[0].status === "resolved" || rows[0].status === "closed") {
    return NextResponse.json(
      { error: "dispute is already resolved", status: rows[0].status },
      { status: 409 }
    );
  }

  const result = await acceptDisputeClaim(disputeRowId, paypalDisputeId, note);

  if (!result.success) {
    return NextResponse.json(
      { error: result.error, httpStatus: result.httpStatus },
      { status: 502 }
    );
  }

  return NextResponse.json({ status: "ok", httpStatus: result.httpStatus });
}
