/**
 * POST /api/delivery/propose/approve
 *
 * Company approves or rejects a payment proposal.
 * On approval:
 *   1. Re-fetch HEAD SHA from GitHub — if changed, mark SUPERSEDED, block payout
 *   2. Update proposal status → approved / rejected
 *   3. On approved: call /api/paypal/payout internally (server-to-server)
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
} from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { fetchPRDetails, GitHubApiError } from "@/lib/delivery/github-client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: company only ────────────────────────────────────────────────────
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company") {
    return NextResponse.json(
      { error: "Forbidden: company role required for approval" },
      { status: 403 }
    );
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

    if (!proposalId || !decision) {
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
    if (decision === "approved" && !recipientEmail) {
      return NextResponse.json(
        { error: "recipientEmail is required when approving" },
        { status: 400 }
      );
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
        // Build a signed role cookie header for the internal server-to-server call
        const { signRoleCookie } = await import("@/lib/auth/role-cookie");
        const cookieHeader = await signRoleCookie("company");

        // Call the existing payout route internally
        const baseUrl = process.env.APP_BASE_URL ?? "";
        const payoutRes = await fetch(`${baseUrl}/api/paypal/payout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader.split(";")[0], // just the value part
          },
          body: JSON.stringify({
            paymentId: paymentRow.id,
            recipientEmail,
            note: `Delivery approved — proposal ${proposalId}`,
          }),
          cache: "no-store",
        });

        payoutResult = await payoutRes.json().catch(() => null);

        if (!payoutRes.ok) {
          // Payout failed after approval — log but don't revert approval
          console.error("[delivery/approve] Payout call failed after approval:", payoutResult);
          await writeAuditLog({
            entityType: "payment",
            entityId: paymentRow.id,
            event: "PAYOUT_TRIGGER_FAILED_AFTER_APPROVAL",
            actor: "system",
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
