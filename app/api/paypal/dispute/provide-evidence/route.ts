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
import { disputes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

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
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  const { disputeRowId, paypalDisputeId, evidenceList, note } = body;

  // Verify dispute row exists and belongs to this system
  const rows = await db
    .select({ id: disputes.id, evidenceStatus: disputes.evidenceStatus })
    .from(disputes)
    .where(eq(disputes.id, disputeRowId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "dispute not found" }, { status: 404 });
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
