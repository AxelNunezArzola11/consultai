"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AgentStep {
  id: string;
  seq: number;
  tool: string;
  inputSummary: string | null;
  outputSummary: string | null;
  evidenceRefs: string[] | null;
  status: "pending" | "running" | "done" | "error";
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

interface PaymentProposal {
  id: string;
  milestoneId: string;
  boundHeadSha: string;
  amountUsd: string;
  policyDecision: string;
  justification: string | null;
  justificationFallback: boolean;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

interface VerificationRun {
  id: string;
  prUrl: string;
  prAuthor: string | null;
  prMerged: boolean | null;
  headSha: string | null;
  flags: string[] | null;
  criteriaResults: Array<{
    criterionId: string;
    kind: string;
    met: boolean | null;
    evidence: string[];
  }> | null;
  justification: string | null;
  justificationFallback: boolean | null;
  policyDecision: string | null;
  status: string;
  durationMs: number | null;
}

interface ActivityStreamProps {
  runId: string;
  recipientEmail?: string;
  onApproved?: () => void;
}

function policyColor(d: string | null): string {
  if (d === "AUTO_RELEASE_ELIGIBLE") return "text-green-600 dark:text-green-400";
  if (d === "REJECT_RECOMMENDED") return "text-destructive";
  return "text-amber-600 dark:text-amber-400";
}

function stepStatusIcon(s: AgentStep["status"]) {
  if (s === "done") return "✓";
  if (s === "error") return "✗";
  if (s === "running") return "⟳";
  return "·";
}

export function ActivityStream({ runId, recipientEmail, onApproved }: ActivityStreamProps) {
  const [run, setRun] = useState<VerificationRun | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [proposals, setProposals] = useState<PaymentProposal[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/delivery/run/${runId}`, { credentials: "same-origin" });
      if (!res.ok) return;
      const data = await res.json();
      setRun(data.run);
      setSteps(data.steps ?? []);
      setProposals(data.proposals ?? []);
    } catch { /* ignore */ }
  }, [runId]);

  useEffect(() => {
    poll();
    // Poll every 2.5 s while run is active
    const interval = setInterval(() => {
      if (run?.status === "running" || run?.status === "pending") {
        poll();
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [poll, run?.status]);

  async function handleDecision(proposalId: string, decision: "approved" | "rejected") {
    setApproving(true);
    setApproveError(null);
    try {
      const res = await fetch("/api/delivery/propose/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ proposalId, decision, recipientEmail, notes }),
      });
      const data = await res.json();
      if (!res.ok) {
        setApproveError(data.error ?? `Error ${res.status}`);
      } else {
        await poll();
        if (decision === "approved" && onApproved) onApproved();
      }
    } catch (e) {
      setApproveError((e as Error).message);
    } finally {
      setApproving(false);
    }
  }

  if (!run) {
    return (
      <div className="text-sm text-muted-foreground animate-pulse">Loading activity stream…</div>
    );
  }

  const proposal = proposals[0] ?? null;
  const flags = (run.flags as string[] | null) ?? [];
  const criteriaResults = run.criteriaResults ?? [];

  return (
    <div className="space-y-4">
      {/* Run header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Badge variant={run.status === "completed" ? "default" : run.status === "failed" ? "destructive" : "outline"}>
          {run.status}
        </Badge>
        {run.headSha && (
          <code className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
            HEAD {run.headSha.substring(0, 8)}
          </code>
        )}
        {run.durationMs && (
          <span className="text-xs text-muted-foreground">{run.durationMs}ms</span>
        )}
        <a
          href={run.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          {run.prUrl}
        </a>
        {run.prAuthor && (
          <span className="text-xs text-muted-foreground">by {run.prAuthor}</span>
        )}
      </div>

      {/* Flags */}
      {flags.length > 0 && (
        <div className="rounded border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">Flags raised</p>
          <div className="flex flex-wrap gap-1">
            {flags.map((f) => (
              <Badge key={f} variant="outline" className="text-xs border-amber-400 text-amber-700 dark:text-amber-300">
                {f}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Activity steps */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Activity stream</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 p-3">
          {steps.length === 0 && (
            <p className="text-xs text-muted-foreground">No steps yet…</p>
          )}
          {steps.map((step) => (
            <div key={step.id} className="border-b last:border-0 pb-1 last:pb-0">
              <button
                className="w-full text-left flex items-start gap-2 py-1 hover:bg-muted/50 rounded px-1"
                onClick={() => setExpanded((e) => ({ ...e, [step.id]: !e[step.id] }))}
              >
                <span className={`text-xs mt-0.5 w-3 shrink-0 ${step.status === "done" ? "text-green-600" : step.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                  {stepStatusIcon(step.status)}
                </span>
                <span className="text-xs font-mono text-muted-foreground shrink-0 w-36">{step.tool}</span>
                <span className="text-xs text-foreground flex-1 truncate">{step.outputSummary}</span>
              </button>
              {expanded[step.id] && (
                <div className="ml-5 text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1 mt-0.5 space-y-1">
                  {step.inputSummary && <p><span className="font-medium">Input:</span> {step.inputSummary}</p>}
                  {step.errorMessage && <p className="text-destructive"><span className="font-medium">Error:</span> {step.errorMessage}</p>}
                  {(step.evidenceRefs ?? []).length > 0 && (
                    <div>
                      <span className="font-medium">Evidence:</span>
                      <ul className="list-disc list-inside mt-0.5">
                        {(step.evidenceRefs ?? []).map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Criteria checklist */}
      {criteriaResults.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Acceptance criteria</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-3">
            {criteriaResults.map((c) => (
              <div key={c.criterionId} className="flex items-start gap-2 text-xs py-0.5">
                <span className={`mt-0.5 shrink-0 ${c.met === true ? "text-green-600" : c.met === false ? "text-destructive" : "text-muted-foreground"}`}>
                  {c.met === true ? "✓" : c.met === false ? "✗" : "?"}
                </span>
                <span className="font-mono text-muted-foreground shrink-0">{c.criterionId}</span>
                <Badge variant="outline" className="text-xs shrink-0">
                  {c.kind === "subjective" ? "subjective" : "objective"}
                </Badge>
                {c.evidence.length > 0 && (
                  <span className="text-muted-foreground truncate">{c.evidence.slice(0, 2).join(", ")}</span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Approval card */}
      {proposal && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Payment proposal</CardTitle>
              <div className="flex items-center gap-2">
                {proposal.status === "auto_release_eligible" && (
                  <Badge className="bg-green-600 text-white text-xs">auto-released</Badge>
                )}
                <Badge
                  variant={proposal.status === "approved" ? "default" : proposal.status === "rejected" ? "destructive" : "outline"}
                  className="text-xs"
                >
                  {proposal.status.replace(/_/g, " ")}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Amount</span>
                <strong className="ml-2">${Number(proposal.amountUsd).toFixed(2)} USD</strong>
              </div>
              <div>
                <span className="text-muted-foreground">Policy</span>
                <strong className={`ml-2 ${policyColor(proposal.policyDecision)}`}>
                  {proposal.policyDecision.replace(/_/g, " ")}
                </strong>
              </div>
              <div>
                <span className="text-muted-foreground">Bound SHA</span>
                <code className="ml-2 text-xs bg-muted px-1 rounded">{proposal.boundHeadSha.substring(0, 8)}</code>
              </div>
            </div>

            {/* Justification */}
            {proposal.justification && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  Justification
                  {proposal.justificationFallback && (
                    <span className="ml-2 text-amber-600">[fallback template]</span>
                  )}
                </p>
                <p className="text-sm border rounded px-3 py-2 bg-muted/30">{proposal.justification}</p>
              </div>
            )}

            {/* Approve / Reject buttons */}
            {(proposal.status === "requires_approval" || proposal.status === "pending") && (
              <div className="space-y-2 pt-2">
                {recipientEmail && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground shrink-0">Notes (optional)</label>
                    <input
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="e.g. looks good — releasing payment"
                      className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
                    />
                  </div>
                )}
                {approveError && (
                  <p className="text-xs text-destructive rounded border border-destructive/30 bg-destructive/10 px-2 py-1">
                    {approveError}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleDecision(proposal.id, "approved")}
                    disabled={approving || !recipientEmail}
                    title={!recipientEmail ? "Set recipientEmail prop to enable approval" : undefined}
                  >
                    {approving ? "Processing…" : "Approve payout"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleDecision(proposal.id, "rejected")}
                    disabled={approving}
                  >
                    Reject
                  </Button>
                </div>
                {!recipientEmail && (
                  <p className="text-xs text-muted-foreground">
                    recipientEmail not provided — approval disabled. Set it via the milestone settings.
                  </p>
                )}
              </div>
            )}

            {proposal.status === "approved" && (
              <p className="text-xs text-green-700 dark:text-green-400">
                ✓ Approved by {proposal.decidedBy} — payout issued
              </p>
            )}
            {proposal.status === "rejected" && (
              <p className="text-xs text-destructive">✗ Rejected by {proposal.decidedBy}</p>
            )}
            {proposal.status === "superseded" && (
              <p className="text-xs text-amber-600">
                ⚠ Superseded — HEAD SHA changed. Freelancer must re-submit.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
