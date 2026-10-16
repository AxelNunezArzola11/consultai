/**
 * GET /api/disputes/[disputeId]
 *
 * Returns the full dispute row from the DB,
 * including the agent's proposal if analysis has run.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { disputes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildEvidencePacket } from "@/lib/disputes/evidence-packet";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> }
): Promise<NextResponse> {
  const { disputeId } = await params;

  if (!disputeId) {
    return NextResponse.json({ error: "missing disputeId" }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "dispute not found" }, { status: 404 });
  }

  const dispute = rows[0];

  // Also return the evidence packet for the UI timeline
  let evidencePacket = null;
  try {
    evidencePacket = await buildEvidencePacket(disputeId);
  } catch {
    // Non-fatal — dispute may be in an incomplete state
  }

  return NextResponse.json({ dispute, evidencePacket });
}
