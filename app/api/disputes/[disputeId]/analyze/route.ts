/**
 * POST /api/disputes/[disputeId]/analyze
 *
 * Triggers the DisputeAgent for a given dispute row ID.
 * Builds the evidence packet, runs the LLM, stores the proposal.
 *
 * The response is a PROPOSAL — no money action is taken.
 * The human must approve via DisputeView before anything executes.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildEvidencePacket } from "@/lib/disputes/evidence-packet";
import { runDisputeAgent } from "@/lib/disputes/dispute-agent";
import { db } from "@/lib/db";
import { disputes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { writeAuditLog } from "@/lib/db/audit";
import { isDemoMode } from "@/lib/demo/config";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> }
): Promise<NextResponse> {
  const { disputeId } = await params;

  if (!disputeId) {
    return NextResponse.json({ error: "missing disputeId" }, { status: 400 });
  }

  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: dispute analysis requires the company or admin role." },
      { status: 403 }
    );
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const dispute = getDemoTables().disputes.find((d) => d.id === disputeId);
    if (!dispute) {
      return NextResponse.json({ error: "dispute not found" }, { status: 404 });
    }
    const proposal = {
      proposedAction: "PROVIDE_EVIDENCE",
      proposedOfferAmountUsd: null,
      writtenResponse:
        "SIMULATED dispute analysis: delivery evidence (approved mockups v3 + PR #87 diff) " +
        "supports requesting a revised delivery before any payout release. Human decision required.",
      reasoning: "Deterministic simulated assessment over fictional evidence — no live LLM ran.",
      confidence: 0.72,
      simulated: true,
    };
    dispute.agentResolution = JSON.stringify({ ...proposal, analyzedAt: new Date().toISOString() });
    dispute.updatedAt = new Date();
    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeId,
      event: "DISPUTE_AGENT_ANALYZED",
      actor: "agent",
      payload: { proposedAction: proposal.proposedAction, confidence: proposal.confidence },
    });
    return NextResponse.json({
      status: "ok",
      proposal,
      evidencePacket: {
        isComplete: true,
        missingRequired: [],
        hasVerificationRun: false,
        hasApproval: false,
        hasPayout: false,
      },
      fallback: false,
      durationMs: 300,
      simulated: true,
    });
  }

  // Build evidence packet
  let packet;
  try {
    packet = await buildEvidencePacket(disputeId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 404 });
  }

  // Run agent (fallback to template if LLM fails)
  const result = await runDisputeAgent(packet);

  // Store agent resolution in disputes table
  await db
    .update(disputes)
    .set({
      agentResolution: JSON.stringify({
        proposedAction: result.response.proposedAction,
        proposedOfferAmountUsd: result.response.proposedOfferAmountUsd ?? null,
        writtenResponse: result.response.writtenResponse,
        reasoning: result.response.reasoning,
        confidence: result.response.confidence,
        fallback: result.fallback,
        modelId: result.modelId,
        promptVersion: result.promptVersion,
        analyzedAt: new Date().toISOString(),
      }),
      updatedAt: new Date(),
    })
    .where(eq(disputes.id, disputeId));

  await writeAuditLog({
    entityType: "dispute",
    entityId: disputeId,
    event: "DISPUTE_AGENT_ANALYZED",
    actor: "agent",
    payload: {
      proposedAction: result.response.proposedAction,
      confidence: result.response.confidence,
      fallback: result.fallback,
      modelId: result.modelId,
      durationMs: result.durationMs,
      missingRequired: packet.missingRequired,
    },
  });

  return NextResponse.json({
    status: "ok",
    proposal: result.response,
    evidencePacket: {
      isComplete: packet.isComplete,
      missingRequired: packet.missingRequired,
      hasVerificationRun: packet.verificationRun !== null,
      hasApproval: packet.approval !== null,
      hasPayout: packet.payout !== null,
    },
    fallback: result.fallback,
    durationMs: result.durationMs,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> }
): Promise<NextResponse> {
  const { disputeId } = await params;

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const dispute = getDemoTables().disputes.find((d) => d.id === disputeId);
    if (!dispute) {
      return NextResponse.json({ error: "dispute not found" }, { status: 404 });
    }
    return NextResponse.json({ dispute });
  }

  const rows = await db
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "dispute not found" }, { status: 404 });
  }

  return NextResponse.json({ dispute: rows[0] });
}
