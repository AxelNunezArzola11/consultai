"use client";

/**
 * DisputeView — Phase 6 / Enterprise Upgrade
 *
 * Displays a dispute with:
 *   1. Project, Milestone, Consultant, and Escrow Payout context
 *   2. Timeline: requested-vs-delivered (dispute creation → delivery events)
 *   3. Verification Evidence packet with completeness check & sources
 *   4. AI Dispute Analysis with explicit DEMO (Simulated) vs LIVE AI badge
 *   5. Human-gated decision controls (Send Evidence | Submit Offer | Record Internal Resolution | Accept Claim)
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CriterionResult {
  criterionId: string;
  description: string;
  met: boolean | null;
  evidence: string[];
}

interface EvidencePacket {
  simulated?: boolean;
  disputeRowId: string;
  paypalDisputeId: string | null;
  disputeStatus: string;
  disputeReasonUntrusted: string | null;
  disputeAmountUsd: string | null;
  disputeLifeCycleStage: string | null;
  milestoneId: string;
  milestoneTitle: string;
  milestoneStatus: string;
  milestonebudgetUsd: string;
  projectTitle: string;
  acceptanceCriteria: Array<{ id: string; description: string; verifiable: boolean }>;
  verificationRun: {
    runId: string;
    prUrl: string;
    headSha: string | null;
    prAuthor: string | null;
    prMerged: boolean | null;
    criteriaResults: CriterionResult[];
    flags: string[];
    justification: string | null;
    policyDecision: string | null;
    completedAt: string | null;
  } | null;
  approval: {
    approvalId: string;
    decidedBy: string | null;
    decidedAt: string | null;
    decision: string;
    notes: string | null;
  } | null;
  payout: {
    paymentId: string;
    grossUsd: string | null;
    feeUsd: string | null;
    netUsd: string | null;
    payoutFeeUsd: string | null;
    paypalCaptureId: string | null;
    status: string;
  } | null;
  consultant: { name: string; githubHandle: string | null } | null;
  deliveryAuditTrail: Array<{ event: string; actor: string; createdAt: string }>;
  missingRequired: string[];
  isComplete: boolean;
}

interface AgentProposal {
  proposedAction: "PROVIDE_EVIDENCE" | "MAKE_OFFER" | "ACCEPT_CLAIM";
  proposedOfferAmountUsd?: string | null;
  writtenResponse: string;
  reasoning: string;
  confidence: number;
  fallback?: boolean;
  simulated?: boolean;
  modelId?: string;
}

interface DisputeRow {
  id: string;
  paypalDisputeId: string | null;
  status: string;
  disputeReason: string | null;
  disputeAmountUsd: string | null;
  evidenceStatus: string;
  evidenceSubmittedAt: string | null;
  offerAmountUsd: string | null;
  offerSubmittedAt: string | null;
  resolutionOutcome?: string | null;
  agentResolution: string | null;
  humanEditedResponse?: string | null;
  milestoneId: string;
}

interface Props {
  disputeId: string;
}

function criterionBadge(met: boolean | null) {
  if (met === true) {
    return (
      <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-300">
        PASS
      </span>
    );
  }
  if (met === false) {
    return (
      <span className="rounded border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-rose-300">
        FAIL
      </span>
    );
  }
  return (
    <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-400">
      PENDING
    </span>
  );
}

function formatTimestamp(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function DisputeView({ disputeId }: Props) {
  const [dispute, setDispute] = useState<DisputeRow | null>(null);
  const [packet, setPacket] = useState<EvidencePacket | null>(null);
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [editedResponse, setEditedResponse] = useState("");
  const [offerAmount, setOfferAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionDone, setActionDone] = useState(false);

  const loadDispute = useCallback(async () => {
    try {
      const res = await fetch(`/api/disputes/${disputeId}`);
      if (!res.ok) {
        toast.error("Failed to load dispute");
        return;
      }
      const data = (await res.json()) as {
        dispute: DisputeRow;
        evidencePacket: EvidencePacket | null;
      };
      setDispute(data.dispute);
      setPacket(data.evidencePacket);

      if (data.dispute.agentResolution) {
        try {
          const stored = JSON.parse(data.dispute.agentResolution) as AgentProposal;
          setProposal(stored);
          setEditedResponse(
            data.dispute.humanEditedResponse || stored.writtenResponse || ""
          );
          setOfferAmount(stored.proposedOfferAmountUsd ?? "");
        } catch {
          /* ignore */
        }
      }
    } finally {
      setLoading(false);
    }
  }, [disputeId]);

  useEffect(() => {
    let active = true;
    fetch(`/api/disputes/${disputeId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            dispute: DisputeRow;
            evidencePacket: EvidencePacket | null;
          } | null
        ) => {
          if (!active || !data) return;
          setDispute(data.dispute);
          setPacket(data.evidencePacket);
          if (data.dispute.agentResolution) {
            try {
              const stored = JSON.parse(
                data.dispute.agentResolution
              ) as AgentProposal;
              setProposal(stored);
              setEditedResponse(
                data.dispute.humanEditedResponse || stored.writtenResponse || ""
              );
              setOfferAmount(stored.proposedOfferAmountUsd ?? "");
            } catch {
              /* ignore */
            }
          }
        }
      )
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [disputeId]);

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/disputes/${disputeId}/analyze`, {
        method: "POST",
      });
      if (!res.ok) {
        toast.error("Analysis failed");
        return;
      }
      const data = (await res.json()) as {
        proposal: AgentProposal;
        fallback: boolean;
        simulated?: boolean;
      };
      setProposal({
        ...data.proposal,
        simulated: data.simulated ?? data.proposal.simulated,
      });
      setEditedResponse(data.proposal.writtenResponse);
      setOfferAmount(data.proposal.proposedOfferAmountUsd ?? "");
      if (data.simulated) {
        toast.info("DEMO Mode: Simulated dispute assessment generated");
      } else if (data.fallback) {
        toast.info("LLM unavailable — using deterministic evidence template");
      } else {
        toast.success("AI Dispute Analysis complete");
      }
      await loadDispute();
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleRecordInternalAction(
    action: "RECORD_EVIDENCE" | "RECORD_OFFER" | "RECORD_RESOLUTION",
    outcome?: string
  ) {
    if (!editedResponse.trim()) {
      toast.error("Enter a written response or decision note first.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/disputes/${disputeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          note: editedResponse,
          offerAmountUsd: offerAmount || undefined,
          outcome,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to record dispute decision");
        return;
      }
      toast.success("Human dispute decision recorded in audit trail ✓");
      setActionDone(true);
      await loadDispute();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProvideEvidence() {
    if (!editedResponse.trim()) {
      toast.error("Enter a written response first");
      return;
    }
    if (packet?.missingRequired && packet.missingRequired.length > 0) {
      toast.error(
        `Evidence packet incomplete: ${packet.missingRequired.join(", ")}`
      );
      return;
    }
    if (packet?.simulated || !dispute?.paypalDisputeId) {
      await handleRecordInternalAction("RECORD_EVIDENCE");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/paypal/dispute/provide-evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeRowId: disputeId,
          paypalDisputeId: dispute.paypalDisputeId,
          evidenceList: [
            {
              evidence_type: "PROOF_OF_FULFILLMENT",
              notes: editedResponse,
              documents: packet?.verificationRun
                ? [{ name: "PR link", url: packet.verificationRun.prUrl }]
                : [],
            },
          ],
          note: editedResponse,
        }),
      });
      if (res.status === 409) {
        toast.info("Evidence was already submitted for this dispute.");
        return;
      }
      if (!res.ok) {
        // Fall back to recording internal evidence state if sandbox API is offline
        await handleRecordInternalAction("RECORD_EVIDENCE");
        return;
      }
      toast.success("Evidence submitted ✓");
      setActionDone(true);
      await loadDispute();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMakeOffer() {
    if (
      !offerAmount ||
      isNaN(parseFloat(offerAmount)) ||
      parseFloat(offerAmount) <= 0
    ) {
      toast.error("Enter a valid offer amount");
      return;
    }
    if (!editedResponse.trim()) {
      toast.error("Enter a written response first");
      return;
    }
    if (packet?.simulated || !dispute?.paypalDisputeId) {
      await handleRecordInternalAction("RECORD_OFFER");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/paypal/dispute/make-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeRowId: disputeId,
          paypalDisputeId: dispute.paypalDisputeId,
          offerAmountUsd: parseFloat(offerAmount).toFixed(2),
          offerType: "PARTIAL_REFUND",
          note: editedResponse,
        }),
      });
      if (!res.ok) {
        await handleRecordInternalAction("RECORD_OFFER");
        return;
      }
      toast.success(`Offer of $${offerAmount} recorded ✓`);
      setActionDone(true);
      await loadDispute();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAcceptClaim() {
    if (!editedResponse.trim()) {
      toast.error("Enter a note explaining why you are accepting the claim");
      return;
    }
    await handleRecordInternalAction(
      "RECORD_RESOLUTION",
      "RESOLVED_BUYER_FAVOR"
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <div className="h-8 w-56 animate-pulse rounded-lg bg-slate-800" />
        <div className="h-40 animate-pulse rounded-2xl bg-slate-900" />
      </div>
    );
  }

  if (!dispute) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-950/30 p-6 text-sm text-rose-200">
          Dispute record not found ({disputeId}).
        </div>
      </div>
    );
  }

  const evidenceAlreadySubmitted = dispute.evidenceStatus === "submitted";
  const offerAlreadySubmitted = !!dispute.offerSubmittedAt;
  const isTerminal =
    dispute.status === "resolved" || dispute.status === "closed";
  const isSimulated = Boolean(packet?.simulated || proposal?.simulated);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-rose-500/20 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-rose-300">
              Escrow Dispute Desk
            </span>
            {isSimulated ? (
              <span className="rounded-full border border-sky-500/40 bg-sky-500/15 px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-sky-300">
                DEMO MODE · Simulated Evidence
              </span>
            ) : (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-amber-300">
                PayPal Sandbox · Human-Gated
              </span>
            )}
          </div>
          <h1 className="mt-2 text-2xl font-bold text-white">
            Dispute Case: {dispute.id}
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            PayPal Dispute Reference:{" "}
            <code className="font-mono text-slate-200">
              {dispute.paypalDisputeId ?? "(internal ledger dispute)"}
            </code>
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Badge variant="outline" className="border-slate-700 bg-slate-900 font-mono text-xs text-slate-200">
            STATUS: {dispute.status.replace(/_/g, " ").toUpperCase()}
          </Badge>
          <Link
            href="/dashboard"
            className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
          >
            ← Back to Dashboard
          </Link>
        </div>
      </div>

      {/* Project, Milestone & Summary Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="border-slate-800 bg-slate-900/90">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Project &amp; Milestone Context
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Project:</span>
              <span className="font-semibold text-white">
                {packet?.projectTitle ?? "Enterprise Project"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Milestone:</span>
              <span className="font-semibold text-slate-200">
                {packet?.milestoneTitle ?? dispute.milestoneId}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Milestone Budget:</span>
              <span className="font-mono text-slate-200">
                ${packet?.milestonebudgetUsd ?? dispute.disputeAmountUsd ?? "0.00"}
              </span>
            </div>
            {packet?.consultant && (
              <div className="flex justify-between">
                <span className="text-slate-400">Consultant:</span>
                <span className="text-blue-400">
                  {packet.consultant.name}{" "}
                  {packet.consultant.githubHandle
                    ? `(@${packet.consultant.githubHandle})`
                    : ""}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-900/90">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Financial &amp; Escrow State
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Disputed Amount:</span>
              <span className="font-mono font-bold text-rose-400">
                {dispute.disputeAmountUsd
                  ? `$${dispute.disputeAmountUsd} USD`
                  : `$${packet?.milestonebudgetUsd ?? "0.00"} USD`}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Lifecycle Stage:</span>
              <span className="font-mono text-slate-200">
                {packet?.disputeLifeCycleStage ?? "INQUIRY"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Evidence Status:</span>
              <span className="font-mono text-emerald-400">
                {dispute.evidenceStatus.replace(/_/g, " ")}
              </span>
            </div>
            {dispute.resolutionOutcome && (
              <div className="flex justify-between">
                <span className="text-slate-400">Resolution Outcome:</span>
                <span className="font-mono text-blue-400">
                  {dispute.resolutionOutcome}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-900/90">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Evidence Packet Completeness
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Packet Status:</span>
              {packet?.isComplete ? (
                <span className="rounded bg-emerald-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-300">
                  COMPLETE ✓
                </span>
              ) : (
                <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-300">
                  PARTIAL
                </span>
              )}
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Acceptance Criteria:</span>
              <span className="font-mono text-slate-200">
                {packet?.acceptanceCriteria.length ?? 0} item(s)
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">PR Verification Run:</span>
              <span className="font-mono text-slate-200">
                {packet?.verificationRun ? "Linked ✓" : "None"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Audit Events:</span>
              <span className="font-mono text-slate-200">
                {packet?.deliveryAuditTrail.length ?? 0} event(s)
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Untrusted Buyer Claim Banner */}
      <Card className="border-amber-500/40 bg-amber-950/20">
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-amber-300">
              ⚠ UNTRUSTED BUYER CLAIM — Isolated from AI System Instructions
            </span>
            <span className="font-mono text-[10px] text-amber-400/80">
              Prompt-Injection Guard Active
            </span>
          </div>
          <p className="mt-1.5 text-sm text-amber-100">
            {dispute.disputeReason ??
              packet?.disputeReasonUntrusted ??
              "(No external buyer reason provided)"}
          </p>
        </CardContent>
      </Card>

      {/* Verification Evidence & Timeline */}
      {packet && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <Card className="border-slate-800 bg-slate-900/90 lg:col-span-7">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold text-white">
                  Acceptance Criteria &amp; Deliverable Evidence
                </CardTitle>
                {evidenceAlreadySubmitted && (
                  <span className="rounded bg-emerald-500/20 px-2.5 py-0.5 font-mono text-[10px] font-bold text-emerald-300">
                    EVIDENCE SUBMITTED ✓
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {packet.verificationRun && (
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-slate-400">Deliverable PR:</span>
                    <a
                      href={packet.verificationRun.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-blue-400 underline hover:text-blue-300"
                    >
                      {packet.verificationRun.prUrl}
                    </a>
                  </div>
                  {packet.verificationRun.headSha && (
                    <div className="mt-1 flex justify-between">
                      <span className="text-slate-500">Bound HEAD SHA:</span>
                      <code className="font-mono text-[11px] text-slate-300">
                        {packet.verificationRun.headSha.slice(0, 12)}
                      </code>
                    </div>
                  )}
                </div>
              )}

              {packet.acceptanceCriteria.map((criterion) => {
                const result = packet.verificationRun?.criteriaResults.find(
                  (r) => r.criterionId === criterion.id
                );
                return (
                  <div
                    key={criterion.id}
                    className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs"
                  >
                    <div className="mt-0.5">
                      {criterionBadge(result?.met ?? true)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-200">
                        [{criterion.id}] {criterion.description}
                      </p>
                      {result?.evidence && result.evidence.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {result.evidence.map((e, i) => (
                            <code
                              key={i}
                              className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300"
                            >
                              {e}
                            </code>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {packet.approval && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
                  Approved by{" "}
                  <strong className="text-slate-200">
                    {packet.approval.decidedBy ?? "company-reviewer"}
                  </strong>{" "}
                  {packet.approval.decidedAt
                    ? `on ${formatTimestamp(packet.approval.decidedAt)}`
                    : ""}
                  {packet.approval.notes && <> · {packet.approval.notes}</>}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Audit Trail */}
          <Card className="border-slate-800 bg-slate-900/90 lg:col-span-5">
            <CardHeader>
              <CardTitle className="text-sm font-bold text-white">
                Delivery &amp; Escrow Audit Trail
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                <span className="font-mono text-blue-400">MILESTONE_SCOPE</span>
                <span className="text-slate-300">{packet.milestoneTitle}</span>
              </div>
              {packet.deliveryAuditTrail.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No additional audit log events recorded for this milestone.
                </p>
              ) : (
                packet.deliveryAuditTrail.map((e, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-slate-950/70 px-3 py-2"
                  >
                    <div>
                      <div className="font-mono font-semibold text-slate-200">
                        {e.event}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Actor: {e.actor}
                      </div>
                    </div>
                    <span className="font-mono text-[11px] text-slate-400">
                      {formatTimestamp(e.createdAt)}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* AI Dispute Agent Proposal & Human Decision Controls */}
      <Card className="border-slate-800 bg-slate-900/90">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base font-bold text-white">
                  AI Dispute Agent Assessment &amp; Response Draft
                </CardTitle>
                {proposal && (
                  <span
                    className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                      proposal.simulated
                        ? "border-sky-500/40 bg-sky-500/15 text-sky-300"
                        : proposal.fallback
                          ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                          : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                    }`}
                  >
                    {proposal.simulated
                      ? "SIMULATED dispute analysis"
                      : proposal.fallback
                        ? "Template Fallback"
                        : "LIVE AI Assessment"}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                AI recommendations never execute financial actions automatically.
                A human operator must review, edit, and confirm below.
              </p>
            </div>

            <Button
              variant="outline"
              size="sm"
              data-testid="analyze-dispute-btn"
              onClick={handleAnalyze}
              disabled={analyzing || isTerminal}
              className="border-blue-500/40 bg-blue-500/15 text-blue-300 hover:bg-blue-500/25"
            >
              {analyzing
                ? "Analyzing Evidence…"
                : proposal
                  ? "Re-analyze Dispute"
                  : "✦ Analyze Dispute"}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {proposal ? (
            <>
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3.5">
                <span className="rounded bg-blue-500/20 px-2.5 py-1 font-mono text-xs font-bold text-blue-300">
                  RECOMMENDED: {proposal.proposedAction.replace(/_/g, " ")}
                </span>
                <span className="font-mono text-xs text-slate-400">
                  Confidence: {(proposal.confidence * 100).toFixed(0)}%
                </span>
                <p className="w-full text-xs leading-relaxed text-slate-300">
                  {proposal.reasoning}
                </p>
              </div>

              <div>
                <label
                  htmlFor="dispute-response-textarea"
                  className="mb-1.5 block font-mono text-xs font-semibold uppercase tracking-wider text-slate-300"
                >
                  Human-Editable Response &amp; Audit Note
                </label>
                <textarea
                  id="dispute-response-textarea"
                  className="min-h-[130px] w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-3.5 font-mono text-xs leading-relaxed text-slate-100 focus:border-blue-500 focus:outline-none"
                  value={editedResponse}
                  onChange={(e) => setEditedResponse(e.target.value)}
                  maxLength={2000}
                  disabled={submitting || actionDone || isTerminal}
                  placeholder="Review and edit the response before recording or submitting…"
                />
                <p className="mt-1 text-right font-mono text-[11px] text-slate-500">
                  {editedResponse.length}/2000
                </p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5">
                <label
                  htmlFor="dispute-offer-input"
                  className="block font-mono text-xs font-semibold uppercase tracking-wider text-slate-300"
                >
                  Optional Partial Settlement Offer (USD)
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <input
                    id="dispute-offer-input"
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="250.00"
                    className="w-36 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-sm text-white"
                    value={offerAmount}
                    onChange={(e) => setOfferAmount(e.target.value)}
                    disabled={submitting || actionDone || isTerminal}
                  />
                  <span className="text-xs text-slate-400">
                    Disputed amount: $
                    {dispute.disputeAmountUsd ??
                      packet?.milestonebudgetUsd ??
                      "0.00"}{" "}
                    USD
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400">
              Click <strong>✦ Run AI Dispute Analysis</strong> above to evaluate
              the milestone verification run, acceptance criteria, and audit
              trail, or enter your human decision note directly below:
              <textarea
                className="mt-3 min-h-[100px] w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-100"
                value={editedResponse}
                onChange={(e) => setEditedResponse(e.target.value)}
                maxLength={2000}
                disabled={submitting || actionDone || isTerminal}
                placeholder="Enter human operator resolution notes or evidence summary…"
              />
            </div>
          )}

          {/* Human Action Buttons */}
          {!isTerminal && !actionDone && (
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button
                data-testid="dispute-submit-evidence"
                onClick={handleProvideEvidence}
                disabled={
                  submitting ||
                  evidenceAlreadySubmitted ||
                  !editedResponse.trim()
                }
                className="bg-blue-600 text-white hover:bg-blue-500"
              >
                {submitting
                  ? "Recording…"
                  : evidenceAlreadySubmitted
                    ? "Evidence Recorded ✓"
                    : "Contest with Evidence"}
              </Button>

              <Button
                variant="outline"
                data-testid="dispute-submit-offer"
                onClick={handleMakeOffer}
                disabled={
                  submitting ||
                  offerAlreadySubmitted ||
                  !offerAmount ||
                  !editedResponse.trim()
                }
                className="border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
              >
                {submitting
                  ? "Recording…"
                  : offerAlreadySubmitted
                    ? "Offer Recorded ✓"
                    : "Propose Partial Settlement"}
              </Button>

              <Button
                variant="outline"
                data-testid="dispute-resolve-internal"
                onClick={() =>
                  handleRecordInternalAction(
                    "RECORD_RESOLUTION",
                    "RESOLVED_SELLER_FAVOR"
                  )
                }
                disabled={submitting || !editedResponse.trim()}
                className="border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
              >
                Record Resolution (Release to Consultant)
              </Button>

              <Button
                variant="destructive"
                data-testid="dispute-accept-claim"
                onClick={handleAcceptClaim}
                disabled={submitting || !editedResponse.trim()}
              >
                Accept Claim (Refund Buyer)
              </Button>
            </div>
          )}

          {actionDone && (
            <div
              data-testid="dispute-action-confirmed"
              className="rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-3.5 text-xs text-emerald-200"
            >
              ✓ Human decision recorded and persisted to the dispute audit
              ledger.
            </div>
          )}

          {isTerminal && (
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3.5 text-xs text-slate-400">
              This dispute is marked <strong>{dispute.status}</strong>{" "}
              {dispute.resolutionOutcome
                ? `(${dispute.resolutionOutcome})`
                : ""}
              . No further actions are required.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
