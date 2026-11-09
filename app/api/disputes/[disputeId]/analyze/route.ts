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
import { disputes, milestones, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { writeAuditLog } from "@/lib/db/audit";
import { isDemoMode } from "@/lib/demo/config";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";

export const dynamic = "force-dynamic";

async function getAuth(req: NextRequest) {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  return { session, role };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> }
): Promise<NextResponse> {
  const { disputeId } = await params;

  if (!disputeId) {
    return NextResponse.json({ error: "missing disputeId" }, { status: 400 });
  }

  const { session, role } = await getAuth(req);
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: dispute analysis requires the company or admin role." },
      { status: 403 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const postIp = getIp(req);
  const postLimit = checkRateLimit("dispute-analyze", postIp, 10, 300);
  if (!postLimit.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(postLimit.retryAfterSec) } }
    );
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const dispute = t.disputes.find((d) => d.id === disputeId);
    if (!dispute) {
      return NextResponse.json({ error: "dispute not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId) {
      const demoMilestone = t.milestones.find((m) => m.id === dispute.milestoneId);
      const demoProject = demoMilestone
        ? t.projects.find((p) => p.id === demoMilestone.projectId)
        : undefined;
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
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

  if (session?.role === "company" && session.companyId) {
    const [disputeRow] = await db
      .select({ milestoneId: disputes.milestoneId })
      .from(disputes)
      .where(eq(disputes.id, disputeId))
      .limit(1);
    const [milestone] = disputeRow?.milestoneId
      ? await db
          .select({ projectId: milestones.projectId })
          .from(milestones)
          .where(eq(milestones.id, disputeRow.milestoneId))
          .limit(1)
      : [];
    const [project] = milestone
      ? await db
          .select({ companyId: projects.companyId })
          .from(projects)
          .where(eq(projects.id, milestone.projectId))
          .limit(1)
      : [];
    if (!disputeRow || !milestone || !project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
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

  const { session, role } = await getAuth(req);
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const getIpAddr = getIp(req);
  const getLimit = checkRateLimit("dispute-analyze-get", getIpAddr, 60, 60);
  if (!getLimit.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(getLimit.retryAfterSec) } }
    );
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const dispute = t.disputes.find((d) => d.id === disputeId);
    if (!dispute) {
      return NextResponse.json({ error: "dispute not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId) {
      const demoMilestone = t.milestones.find((m) => m.id === dispute.milestoneId);
      const demoProject = demoMilestone
        ? t.projects.find((p) => p.id === demoMilestone.projectId)
        : undefined;
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
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
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  return NextResponse.json({ dispute: rows[0] });
}
