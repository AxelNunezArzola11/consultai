"use client";

/**
 * DisputeView — Phase 6
 *
 * Displays a dispute with:
 *   1. Timeline: requested-vs-delivered (dispute creation → delivery events)
 *   2. Evidence list with sources (from the evidence packet)
 *   3. Editable written response (agent-drafted, human-editable)
 *   4. Offer amount control with fee implications (shown as UNVERIFIED)
 *   5. Action buttons: Send Evidence | Make Offer | Accept Claim
 *
 * DESIGN RULES:
 *   - All money actions require explicit human click (no auto-submit)
 *   - Agent proposal is displayed as "suggested" — human can edit
 *   - Buyer-provided data (dispute reason) is shown with UNTRUSTED label
 *   - Fee implications are shown as UNVERIFIED until sandbox confirms
 */

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CriterionResult {
  criterionId: string;
  description: string;
  met: boolean | null;
  evidence: string[];
}

interface EvidencePacket {
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
  proposedOfferAmountUsd?: string;
  writtenResponse: string;
  reasoning: string;
  confidence: number;
  fallback?: boolean;
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
  agentResolution: string | null;
  milestoneId: string;
}

interface Props {
  disputeId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "open":
    case "waiting_for_seller": return "destructive";
    case "waiting_for_buyer": return "secondary";
    case "under_review": return "outline";
    case "escalated": return "destructive";
    case "resolved": return "default";
    case "closed": return "secondary";
    default: return "outline";
  }
}

function criterionBadge(met: boolean | null) {
  if (met === true)  return <Badge className="bg-green-100 text-green-800 border-green-300">PASS</Badge>;
  if (met === false) return <Badge variant="destructive">FAIL</Badge>;
  return <Badge variant="outline">PENDING</Badge>;
}

function formatTimestamp(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DisputeView({ disputeId }: Props) {
  const [dispute, setDispute]           = useState<DisputeRow | null>(null);
  const [packet, setPacket]             = useState<EvidencePacket | null>(null);
  const [proposal, setProposal]         = useState<AgentProposal | null>(null);
  const [editedResponse, setEditedResponse] = useState("");
  const [offerAmount, setOfferAmount]   = useState("");
  const [loading, setLoading]           = useState(true);
  const [analyzing, setAnalyzing]       = useState(false);
  const [submitting, setSubmitting]     = useState(false);
  const [actionDone, setActionDone]     = useState(false);

  // Load dispute data
  useEffect(() => {
    void loadDispute();
  }, [disputeId]);

  async function loadDispute() {
    setLoading(true);
    try {
      const res = await fetch(`/api/disputes/${disputeId}`);
      if (!res.ok) { toast.error("Failed to load dispute"); return; }
      const data = await res.json() as { dispute: DisputeRow; evidencePacket: EvidencePacket | null };
      setDispute(data.dispute);
      setPacket(data.evidencePacket);

      // Parse stored agent resolution if present
      if (data.dispute.agentResolution) {
        try {
          const stored = JSON.parse(data.dispute.agentResolution) as AgentProposal;
          setProposal(stored);
          setEditedResponse(stored.writtenResponse ?? "");
          setOfferAmount(stored.proposedOfferAmountUsd ?? "");
        } catch { /* ignore */ }
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/disputes/${disputeId}/analyze`, { method: "POST" });
      if (!res.ok) { toast.error("Analysis failed"); return; }
      const data = await res.json() as { proposal: AgentProposal; fallback: boolean };
      setProposal(data.proposal);
      setEditedResponse(data.proposal.writtenResponse);
      setOfferAmount(data.proposal.proposedOfferAmountUsd ?? "");
      if (data.fallback) toast.info("LLM unavailable — using fallback template");
      else toast.success("Analysis complete");
      await loadDispute();
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleProvideEvidence() {
    if (!dispute?.paypalDisputeId) { toast.error("No PayPal dispute ID"); return; }
    if (!editedResponse.trim()) { toast.error("Enter a written response first"); return; }
    if (packet?.missingRequired && packet.missingRequired.length > 0) {
      toast.error(`Evidence packet incomplete: ${packet.missingRequired.join(", ")}`);
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
        const err = await res.json() as { error: string };
        toast.error(`Failed to submit evidence: ${err.error}`);
        return;
      }
      toast.success("Evidence submitted to PayPal ✓");
      setActionDone(true);
      await loadDispute();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMakeOffer() {
    if (!dispute?.paypalDisputeId) { toast.error("No PayPal dispute ID"); return; }
    if (!offerAmount || isNaN(parseFloat(offerAmount)) || parseFloat(offerAmount) <= 0) {
      toast.error("Enter a valid offer amount");
      return;
    }
    if (!editedResponse.trim()) { toast.error("Enter a written response first"); return; }
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
      if (res.status === 409) {
        toast.info("An offer was already submitted for this dispute.");
        return;
      }
      if (!res.ok) {
        const err = await res.json() as { error: string };
        toast.error(`Failed to submit offer: ${err.error}`);
        return;
      }
      toast.success(`Offer of $${offerAmount} submitted to PayPal ✓`);
      setActionDone(true);
      await loadDispute();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAcceptClaim() {
    if (!dispute?.paypalDisputeId) { toast.error("No PayPal dispute ID"); return; }
    if (!editedResponse.trim()) { toast.error("Enter a note explaining why you are accepting the claim"); return; }
    if (!confirm(
      "⚠️ Accepting the claim will refund the buyer from your account. " +
        "This is irreversible. Are you sure?"
    )) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/paypal/dispute/accept-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeRowId: disputeId,
          paypalDisputeId: dispute.paypalDisputeId,
          note: editedResponse,
        }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        toast.error(`Failed to accept claim: ${err.error}`);
        return;
      }
      toast.success("Claim accepted. PayPal will process the refund.");
      setActionDone(true);
      await loadDispute();
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-8 w-48 rounded bg-muted animate-pulse mb-4" />
        <div className="h-32 rounded bg-muted animate-pulse" />
      </div>
    );
  }

  if (!dispute) {
    return <div className="p-6 text-destructive">Dispute not found.</div>;
  }

  const evidenceAlreadySubmitted = dispute.evidenceStatus === "submitted";
  const offerAlreadySubmitted    = !!dispute.offerSubmittedAt;
  const isTerminal = dispute.status === "resolved" || dispute.status === "closed";

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dispute</h1>
          <p className="text-sm text-muted-foreground mt-1">
            PayPal ID: <code className="font-mono">{dispute.paypalDisputeId ?? "(pending)"}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusBadgeVariant(dispute.status)}>{dispute.status.replace(/_/g, " ").toUpperCase()}</Badge>
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Sandbox</span>
        </div>
      </div>

      {/* Dispute summary */}
      <Card>
        <CardHeader><CardTitle className="text-base">Dispute Summary</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <span className="text-muted-foreground">Amount in dispute</span>
            <span className="font-medium">{dispute.disputeAmountUsd ? `$${dispute.disputeAmountUsd} USD` : "(unknown)"}</span>
            <span className="text-muted-foreground">Life cycle stage</span>
            <span>{packet?.disputeLifeCycleStage ?? "(unknown)"}</span>
          </div>
          {/* Buyer-provided reason — marked UNTRUSTED */}
          <div className="mt-2 p-3 rounded border border-yellow-300 bg-yellow-50">
            <p className="text-xs font-semibold text-yellow-800 mb-1">
              UNTRUSTED — Buyer-provided reason (from PayPal, not verified by us)
            </p>
            <p className="text-sm text-yellow-900">
              {dispute.disputeReason ?? packet?.disputeReasonUntrusted ?? "(no reason provided)"}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Timeline: requested vs delivered */}
      {packet && (
        <Card>
          <CardHeader><CardTitle className="text-base">Timeline: Requested vs Delivered</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                <span className="text-muted-foreground">Milestone:</span>
                <span className="font-medium">{packet.milestoneTitle}</span>
                <span className="text-muted-foreground ml-auto">Budget: ${packet.milestonebudgetUsd}</span>
              </div>
              {packet.verificationRun && (
                <div className="flex items-center gap-2 text-sm ml-4">
                  <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                  <span className="text-muted-foreground">Delivered:</span>
                  <a
                    href={packet.verificationRun.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline font-mono text-xs truncate max-w-xs"
                  >
                    {packet.verificationRun.prUrl}
                  </a>
                  <span className="text-muted-foreground ml-auto text-xs">
                    {packet.verificationRun.completedAt ? formatTimestamp(packet.verificationRun.completedAt) : ""}
                  </span>
                </div>
              )}
              {packet.deliveryAuditTrail.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-xs ml-4 text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0" />
                  <span>{e.event}</span>
                  <span className="ml-auto">{formatTimestamp(e.createdAt)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Evidence list */}
      {packet?.verificationRun && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Verification Evidence</CardTitle>
              {evidenceAlreadySubmitted && (
                <Badge className="bg-green-100 text-green-800">Evidence Submitted</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {packet.acceptanceCriteria.map((criterion) => {
              const result = packet.verificationRun!.criteriaResults.find(
                (r) => r.criterionId === criterion.id
              );
              return (
                <div key={criterion.id} className="flex items-start gap-3 text-sm border rounded p-3">
                  <div className="mt-0.5">{criterionBadge(result?.met ?? null)}</div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">[{criterion.id}] {criterion.description}</p>
                    {result?.evidence && result.evidence.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {result.evidence.map((e, i) => (
                          <code key={i} className="text-xs bg-muted rounded px-1">{e}</code>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {packet.verificationRun.flags.length > 0 && (
              <div className="text-xs text-orange-700 p-2 rounded bg-orange-50 border border-orange-200">
                ⚠️ Flags: {packet.verificationRun.flags.join(", ")}
              </div>
            )}
            {packet.approval && (
              <div className="text-xs text-muted-foreground mt-2">
                Approved by {packet.approval.decidedBy ?? "reviewer"} on {packet.approval.decidedAt ? formatTimestamp(packet.approval.decidedAt) : "record date"}
                {packet.approval.notes && <> · Notes: {packet.approval.notes}</>}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Agent proposal */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Agent-Suggested Response</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={handleAnalyze}
              disabled={analyzing || isTerminal}
            >
              {analyzing ? "Analyzing…" : proposal ? "Re-analyze" : "Analyze Dispute"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {proposal ? (
            <>
              <div className="flex items-center gap-3">
                <Badge
                  variant={
                    proposal.proposedAction === "ACCEPT_CLAIM" ? "destructive" :
                    proposal.proposedAction === "MAKE_OFFER" ? "secondary" : "default"
                  }
                >
                  {proposal.proposedAction.replace(/_/g, " ")}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Confidence: {(proposal.confidence * 100).toFixed(0)}%
                  {proposal.fallback && " · fallback template"}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{proposal.reasoning}</p>

              {/* Editable written response */}
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
                  Written Response to PayPal (editable)
                </label>
                <textarea
                  className="w-full min-h-[140px] rounded border p-3 text-sm font-mono resize-y"
                  value={editedResponse}
                  onChange={(e) => setEditedResponse(e.target.value)}
                  maxLength={2000}
                  disabled={submitting || actionDone || isTerminal}
                  placeholder="Review and edit the agent's suggested response before submitting to PayPal…"
                />
                <p className="text-xs text-muted-foreground text-right">{editedResponse.length}/2000</p>
              </div>

              {/* Offer amount control */}
              {proposal.proposedAction === "MAKE_OFFER" && (
                <div className="p-3 rounded border space-y-2">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide block">
                    Offer Amount (USD)
                  </label>
                  <div className="flex items-center gap-3">
                    <span className="text-sm">$</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      className="border rounded p-2 text-sm w-32"
                      value={offerAmount}
                      onChange={(e) => setOfferAmount(e.target.value)}
                      disabled={submitting || actionDone || isTerminal}
                    />
                    <span className="text-xs text-muted-foreground">
                      Original gross: ${packet?.payout?.grossUsd ?? "?"} ·
                      Net platform received: ${packet?.payout?.netUsd ?? "?"}
                    </span>
                  </div>
                  <p className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded p-2">
                    ⚠️ Fee implications UNVERIFIED: whether PayPal returns the original capture fee
                    on a dispute refund is not confirmed. The platform may absorb the fee.
                    Confirm at https://www.paypal.com/us/webapps/mpp/merchant-fees before production.
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Click "Analyze Dispute" to have the agent review the evidence and suggest a response.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Evidence packet completeness warning */}
      {packet && !packet.isComplete && (
        <div className="p-3 rounded border border-red-300 bg-red-50 text-sm text-red-800">
          <strong>Incomplete evidence packet.</strong> Missing:{" "}
          {packet.missingRequired.join(", ")}.
          Evidence submission will be blocked until all required fields are present.
        </div>
      )}

      {/* Action buttons */}
      {!isTerminal && !actionDone && proposal && (
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleProvideEvidence}
            disabled={submitting || evidenceAlreadySubmitted || !packet?.isComplete}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {submitting ? "Submitting…" : evidenceAlreadySubmitted ? "Evidence Sent ✓" : "Send Evidence to PayPal"}
          </Button>

          <Button
            variant="outline"
            onClick={handleMakeOffer}
            disabled={submitting || offerAlreadySubmitted || !offerAmount}
          >
            {submitting ? "Submitting…" : offerAlreadySubmitted ? "Offer Sent ✓" : "Submit Offer"}
          </Button>

          <Button
            variant="destructive"
            onClick={handleAcceptClaim}
            disabled={submitting}
          >
            Accept Claim (Concede)
          </Button>
        </div>
      )}

      {actionDone && (
        <div className="p-3 rounded border border-green-300 bg-green-50 text-sm text-green-800">
          ✓ Action submitted. Refresh to see updated dispute status.
        </div>
      )}

      {isTerminal && (
        <div className="p-3 rounded border text-sm text-muted-foreground">
          This dispute is {dispute.status}. No further actions available.
        </div>
      )}
    </div>
  );
}
