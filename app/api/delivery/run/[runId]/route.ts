/**
 * GET /api/delivery/run/[runId]
 *
 * Returns the full verification run with its agent steps and payment proposal.
 * Used by the UI to poll for status (every 2–3 s during an active run).
 *
 * Auth: any valid role (both company and freelancer can view).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { verificationRuns, agentSteps, paymentProposals } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<NextResponse> {
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (!role) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }

  const [run] = await db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.id, runId))
    .limit(1);

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const steps = await db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId))
    .orderBy(agentSteps.seq);

  const proposals = await db
    .select()
    .from(paymentProposals)
    .where(eq(paymentProposals.runId, runId));

  return NextResponse.json({ run, steps, proposals });
}
