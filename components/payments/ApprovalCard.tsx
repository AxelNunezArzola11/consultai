"use client";

/**
 * ApprovalCard — client component
 *
 * Displays payout details and provides an Approve button.
 * Calls POST /api/paypal/payout (first time) or POST /api/paypal/payout/approve (for held payouts).
 *
 * For the Phase 1 demo: the freelancer email is hardcoded to the SANDBOX_FREELANCER_EMAIL
 * env var or entered inline. In Phase 2+, it comes from the selected candidate's email.
 */

import { useState } from "react";
import { toast } from "sonner";

interface Props {
  paymentId:       string;
  milestoneTitle:  string;
  amountUsd:       string | null;
  currency:        string;
  justification?:  string;
  candidateName?:  string;
  candidateEmail?: string;
  approvalId?:     string;
  milestoneStatus: string;
  paymentStatus:   string;
}

export function ApprovalCard({
  paymentId,
  milestoneTitle,
  amountUsd,
  currency,
  justification,
  candidateName,
  candidateEmail: initialEmail,
  approvalId,
  milestoneStatus,
  paymentStatus,
}: Props) {
  const [loading, setLoading]           = useState(false);
  const [done, setDone]                 = useState(false);
  const [result, setResult]             = useState<Record<string, unknown> | null>(null);
  const [recipientEmail, setEmail]      = useState(initialEmail ?? "");
  const [note, setNote]                 = useState("");

  const isActionable =
    milestoneStatus === "funded" ||
    milestoneStatus === "pending_approval";
  const isProcessing = milestoneStatus === "verifying" || paymentStatus === "processing";
  const isPaid       = milestoneStatus === "paid"      || paymentStatus === "succeeded";

  async function handleApprove() {
    if (!recipientEmail) {
      toast.error("Enter the freelancer's PayPal email first");
      return;
    }
    setLoading(true);
    try {
      let url  = "/api/paypal/payout";
      let body: Record<string, unknown> = { paymentId, recipientEmail, note };

      // If there's already a pending approval record, call the approve endpoint
      if (approvalId) {
        url  = "/api/paypal/payout/approve";
        body = { approvalId, recipientEmail, note };
      }

      const res  = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await res.json() as Record<string, unknown>;

      if (!res.ok) {
        toast.error(`Payout error: ${String(data.error ?? "unknown")}`);
        return;
      }

      if (data.status === "pending_approval") {
        toast.info(`Approval created — amount $${amountUsd} exceeds threshold`);
        setResult(data);
      } else {
        toast.success(
          data.isReplay
            ? "Idempotent replay — payout already issued"
            : `Payout issued — batch ${String(data.batchId)}`
        );
        setDone(true);
        setResult(data);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Payout failed");
    } finally {
      setLoading(false);
    }
  }

  if (isPaid) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 px-4 py-3 text-sm font-medium text-green-700 dark:text-green-400">
        ✓ Paid — payout sent to consultant
      </div>
    );
  }

  if (isProcessing) {
    return (
      <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Payout processing — waiting for PayPal webhook confirmation
      </div>
    );
  }

  if (done && result) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 px-4 py-3 text-sm space-y-1">
        <p className="font-medium text-green-700 dark:text-green-400">
          {result.isReplay ? "↩ Replay — original payout" : "✓ Payout issued"}
        </p>
        <p className="text-xs text-muted-foreground font-mono">
          Batch: {String(result.batchId)}
        </p>
        <p className="text-xs text-muted-foreground">
          Status: {String(result.batchStatus)} · Amount: ${amountUsd} {currency}
        </p>
        {Boolean(result.isReplay) && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            ⚠ Idempotent replay — no second payment was created
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {justification && (
        <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium">Justification: </span>{justification}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            Freelancer PayPal email
          </label>
          <input
            type="email"
            value={recipientEmail}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="freelancer@example.com"
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm
              focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {candidateName && (
            <p className="text-[11px] text-muted-foreground mt-0.5">{candidateName}</p>
          )}
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            Note (optional)
          </label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Milestone completion payment"
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm
              focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Payout amount: </span>
          <strong className="text-foreground">${amountUsd ? Number(amountUsd).toFixed(2) : "—"} {currency}</strong>
          <span className="text-muted-foreground text-[11px] ml-2">(net after capture fee)</span>
        </div>

        {isActionable && (
          <button
            onClick={() => { void handleApprove(); }}
            disabled={loading || !recipientEmail}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium
              bg-green-600 text-white hover:bg-green-700 disabled:opacity-50
              disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Sending…
              </>
            ) : (
              approvalId ? "Approve & Release Payout" : "Release Payout"
            )}
          </button>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Payout via PayPal Payouts API · Sandbox mode · Consultant receives full net amount
      </p>
    </div>
  );
}
