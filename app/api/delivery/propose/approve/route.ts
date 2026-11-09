/**
 * POST /api/delivery/propose/approve
 *
 * Company approves or rejects a payment proposal.
 * On approval:
 *   1. Re-fetch HEAD SHA from GitHub — if changed, mark SUPERSEDED, block payout
 *   2. Update proposal status → approved / rejected
 *   3. On approved: execute the payout in-process via executeDirectPayout
 *      (same logic as /api/paypal/payout, keeping this request's auth context)
 *   4. Write audit log
 *
 * Body: {
 *   proposalId: string,
 *   decision: "approved" | "rejected",
 *   recipientEmail: string,  -- required for approval, ignored for rejection
 *   notes?: string,
 * }
 *
 * Auth: requires role=company (approve/reject is company-only).
 * Rate limit: 10 approvals per IP per 60 s.
 *
 * The proposal MUST be in status "requires_approval" or "auto_release_eligible".
 * Double-approve is idempotent (returns existing state).
 *
 * SHA re-check rule (from design spec):
 *   Re-fetch head SHA at approval time AND right before payout.
 *   If SHA changed → mark SUPERSEDED, return error, require re-verification.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import {
  paymentProposals,
  verificationRuns,
  payments,
  milestones,
  projects,
} from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { fetchPRDetails, GitHubApiError } from "@/lib/delivery/github-client";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: company or admin ────────────────────────────────────────────────
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: company or admin role required for approval" },
      { status: 403 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("delivery-approve", ip, 10, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  try {
    const body = await req.json().catch(() => null);
    const proposalId = body?.proposalId as string | undefined;
    const decision = body?.decision as string | undefined;
    const recipientEmail = body?.recipientEmail as string | undefined;
    const notes = (body?.notes as string | undefined) ?? null;

    if (!proposalId || typeof proposalId !== "string" || proposalId.length > 100 ||
        !decision || typeof decision !== "string") {
      return NextResponse.json(
        { error: "proposalId and decision are required" },
        { status: 400 }
      );
    }
    if (decision !== "approved" && decision !== "rejected") {
      return NextResponse.json(
        { error: "decision must be 'approved' or 'rejected'" },
        { status: 400 }
      );
    }
    if (decision === "approved" &&
        (!recipientEmail || typeof recipientEmail !== "string" ||
         recipientEmail.length > 320 ||
         !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail))) {
      return NextResponse.json(
        { error: "recipientEmail is required when approving" },
        { status: 400 }
      );
    }
    if (notes !== null && notes !== undefined &&
        (typeof notes !== "string" || notes.length > 2000)) {
      return NextResponse.json({ error: "invalid notes" }, { status: 400 });
    }

    // ── Demo mode: record the decision, NEVER execute a payout ──────────
    if (isDemoMode()) {
      const { getDemoTables } = await import("@/lib/demo/store");
      const t = getDemoTables();
      const proposal = t.paymentProposals.find((p) => p.id === proposalId);
      if (!proposal) {
        return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
      }
      if (session?.role === "company" && session.companyId) {
        const demoMilestone = t.milestones.find((m) => m.id === proposal.milestoneId);
        const demoProject = demoMilestone
          ? t.projects.find((p) => p.id === demoMilestone.projectId)
          : undefined;
        if (!demoProject || demoProject.companyId !== session.companyId) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
      if (proposal.status === "approved") {
        return NextResponse.json({
          status: "ok",
          message: "Proposal already approved (idempotent)",
          proposalId,
          decision: "approved",
          simulated: true,
        });
      }
      if (proposal.status === "rejected") {
        return NextResponse.json({
          status: "ok",
          message: "Proposal already rejected",
          proposalId,
          decision: "rejected",
          simulated: true,
        });
      }
      const approvableStatuses = ["pending", "requires_approval", "auto_release_eligible"];
      if (!approvableStatuses.includes(proposal.status)) {
        return NextResponse.json(
          { error: `Proposal is in status '${proposal.status}' — cannot approve` },
          { status: 409 }
        );
      }
      const decidedAt = new Date();
      proposal.status = decision === "approved" ? "approved" : "rejected";
      proposal.decidedBy = "company";
      proposal.decidedAt = decidedAt;
      proposal.decisionNotes = notes;
      proposal.updatedAt = decidedAt;
      await writeAuditLog({
        entityType: "milestone",
        entityId: proposal.milestoneId,
        event: decision === "approved" ? "PROPOSAL_APPROVED" : "PROPOSAL_REJECTED",
        actor: "company",
        payload: { proposalId, amountUsd: proposal.amountUsd, notes },
      });
      return NextResponse.json({
        status: "ok",
        proposalId,
        decision,
        boundSha: proposal.boundHeadSha.substring(0, 8),
        payout: null,
        payoutExecuted: false,
        payoutNote:
          "Offline demo mode: the approval decision is recorded, but no payout is executed. " +
          "No simulated payment is reported as completed.",
        simulated: true,
      });
    }

    // ── Load proposal ─────────────────────────────────────────────────────
    const [proposal] = await db
      .select()
      .from(paymentProposals)
      .where(eq(paymentProposals.id, proposalId))
      .limit(1);

    if (!proposal) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }

    if (session?.role === "company" && session.companyId) {
      const [proposalMilestone] = await db
        .select({ projectId: milestones.projectId })
        .from(milestones)
        .where(eq(milestones.id, proposal.milestoneId))
        .limit(1);
      const [proposalProject] = proposalMilestone
        ? await db
            .select({ companyId: projects.companyId })
            .from(projects)
            .where(eq(projects.id, proposalMilestone.projectId))
            .limit(1)
        : [];
      if (!proposalMilestone || !proposalProject ||
          proposalProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // Idempotent: already decided
    if (proposal.status === "approved") {
      return NextResponse.json({
        status: "ok",
        message: "Proposal already approved (idempotent)",
        proposalId,
        decision: "approved",
      });
    }
    if (proposal.status === "rejected") {
      return NextResponse.json({
        status: "ok",
        message: "Proposal already rejected",
        proposalId,
        decision: "rejected",
      });
    }
    if (proposal.status === "superseded") {
      return NextResponse.json(
        { error: "Proposal is superseded — HEAD SHA changed. Re-submit the PR URL for a new verification." },
        { status: 409 }
      );
    }

    // Must be in an approvable state
    const approvableStatuses = ["pending", "requires_approval", "auto_release_eligible"];
    if (!approvableStatuses.includes(proposal.status)) {
      return NextResponse.json(
        { error: `Proposal is in status '${proposal.status}' — cannot approve` },
        { status: 409 }
      );
    }

    // ── Load verification run ─────────────────────────────────────────────
    const [run] = await db
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.id, proposal.runId))
      .limit(1);

    if (!run) {
      return NextResponse.json(
        { error: "Verification run not found" },
        { status: 404 }
      );
    }

    // ── SHA re-check (approval time) ──────────────────────────────────────
    if (decision === "approved") {
      let currentSha: string;
      try {
        const currentPr = await fetchPRDetails(run.prOwner, run.prRepo, run.prNumber);
        currentSha = currentPr.headSha;
      } catch (err) {
        const msg = err instanceof GitHubApiError
          ? `GitHub ${err.status}: ${err.message}`
          : (err as Error).message;
        return NextResponse.json(
          { error: `Cannot verify HEAD SHA — ${msg}` },
          { status: 502 }
        );
      }

      if (currentSha !== proposal.boundHeadSha) {
        // Mark proposal SUPERSEDED
        await db
          .update(paymentProposals)
          .set({
            status: "superseded",
            decisionNotes: `SHA changed: was ${proposal.boundHeadSha.substring(0, 8)}, now ${currentSha.substring(0, 8)}`,
            updatedAt: new Date(),
          })
          .where(eq(paymentProposals.id, proposalId));

        await writeAuditLog({
          entityType: "milestone",
          entityId: proposal.milestoneId,
          event: "PROPOSAL_SUPERSEDED",
          actor: "company",
          payload: {
            proposalId,
            boundSha: proposal.boundHeadSha.substring(0, 8),
            currentSha: currentSha.substring(0, 8),
          },
        });

        return NextResponse.json(
          {
            error: "HEAD SHA changed since verification — proposal is now SUPERSEDED",
            boundSha: proposal.boundHeadSha.substring(0, 8),
            currentSha: currentSha.substring(0, 8),
            action: "Re-submit the PR URL via /api/delivery/verify for a new verification run",
          },
          { status: 409 }
        );
      }
    }

    // ── Apply decision ────────────────────────────────────────────────────
    const decidedAt = new Date();

    await db
      .update(paymentProposals)
      .set({
        status: decision === "approved" ? "approved" : "rejected",
        decidedBy: "company",
        decidedAt,
        decisionNotes: notes,
        updatedAt: decidedAt,
      })
      .where(eq(paymentProposals.id, proposalId));

    await writeAuditLog({
      entityType: "milestone",
      entityId: proposal.milestoneId,
      event: decision === "approved" ? "PROPOSAL_APPROVED" : "PROPOSAL_REJECTED",
      actor: "company",
      payload: {
        proposalId,
        boundSha: proposal.boundHeadSha.substring(0, 8),
        amountUsd: proposal.amountUsd,
        policyDecision: proposal.policyDecision,
        notes,
      },
    });

    // ── On approval: trigger payout via existing route ────────────────────
    let payoutResult: Record<string, unknown> | null = null;
    if (decision === "approved") {
      // Find the payment row for this milestone
      const [paymentRow] = await db
        .select()
        .from(payments)
        .where(eq(payments.milestoneId, proposal.milestoneId))
        .limit(1);

      if (paymentRow) {
        // Execute the payout in-process instead of an HTTP round-trip to
        // /api/paypal/payout. The old path minted a fresh company role cookie
        // for the internal call, discarding the caller's session (and its
        // company scoping); the direct call keeps this request's auth context.
        const { executeDirectPayout } = await import("@/lib/payments/direct-payout");
        const direct = await executeDirectPayout({
          paymentId: paymentRow.id,
          recipientEmail: recipientEmail as string,
          note: `Delivery approved — proposal ${proposalId}`,
          bypass_approval: false,
        });
        payoutResult = direct as unknown as Record<string, unknown>;

        if (direct.error) {
          // Payout failed after approval — log but don't revert approval
          console.error("[delivery/approve] Payout call failed after approval:", payoutResult);
          await writeAuditLog({
            entityType: "payment",
            entityId: paymentRow.id,
            event: "PAYOUT_TRIGGER_FAILED_AFTER_APPROVAL",
            actor: session ? `${session.role}:${session.userId}` : "system",
            payload: { proposalId, payoutResult },
          });
        }
      }
    }

    return NextResponse.json({
      status: "ok",
      proposalId,
      decision,
      boundSha: proposal.boundHeadSha.substring(0, 8),
      payout: payoutResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[delivery/approve] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
