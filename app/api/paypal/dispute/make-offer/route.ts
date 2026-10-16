/**
 * POST /api/paypal/dispute/make-offer
 *
 * Server-side route called ONLY after human approves an offer amount in DisputeView.
 * Makes a settlement offer for a dispute via PayPal Disputes REST API.
 *
 * IMPORTANT: Never called automatically. Human approval required.
 * UNVERIFIED: PayPal make-offer endpoint not yet called in sandbox.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { makeDisputeOffer } from "@/lib/paypal/dispute-tools";
import { db } from "@/lib/db";
import { disputes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  disputeRowId: z.string().min(1),
  paypalDisputeId: z.string().min(1),
  offerAmountUsd: z.string().regex(/^\d+(\.\d{1,2})?$/),
  offerType: z.enum(["REFUND", "PARTIAL_REFUND"]),
  note: z.string().min(1).max(2000),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  const { disputeRowId, paypalDisputeId, offerAmountUsd, offerType, note } = body;

  // Verify dispute row exists
  const rows = await db
    .select({ id: disputes.id, offerSubmittedAt: disputes.offerSubmittedAt })
    .from(disputes)
    .where(eq(disputes.id, disputeRowId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "dispute not found" }, { status: 404 });
  }

  if (rows[0].offerSubmittedAt) {
    return NextResponse.json(
      { error: "offer already submitted", offerSubmittedAt: rows[0].offerSubmittedAt },
      { status: 409 }
    );
  }

  const result = await makeDisputeOffer(
    disputeRowId,
    paypalDisputeId,
    offerAmountUsd,
    offerType,
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
