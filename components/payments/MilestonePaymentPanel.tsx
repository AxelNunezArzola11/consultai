"use client";

/**
 * MilestonePaymentPanel — client component
 *
 * Shows the appropriate action/status for a milestone based on its payment status:
 *   planned          → MilestoneFundButton (PayPal v6 checkout)
 *   funded           → "Held (simulated)" confirmation card
 *   pending_approval → Approval waiting indicator
 *   verifying        → Processing indicator
 *   paid             → Paid confirmation
 *   failed/returned  → Error state
 *
 * Also shows a mini event timeline from the audit log.
 */

import { useState } from "react";
import { MilestoneFundButton, type FundResult } from "./MilestoneFundButton";

interface AuditEntry {
  id:        string;
  event:     string;
  actor:     string;
  createdAt: string;
}

interface Props {
  milestoneId:    string;
  milestoneTitle: string;
  budgetUsd:      string;
  status:         string;
  captureId:      string | null;
  orderId:        string | null;
  auditEntries:   AuditEntry[];
}

export function MilestonePaymentPanel({
  milestoneId,
  milestoneTitle,
  budgetUsd,
  status: initialStatus,
  captureId: initialCaptureId,
  orderId: initialOrderId,
  auditEntries: initialAudit,
}: Props) {
  const [status, setStatus]           = useState(initialStatus);
  const [fundResult, setFundResult]   = useState<FundResult | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>(initialAudit);

  function handleFunded(result: FundResult) {
    setStatus("funded");
    setFundResult(result);
    // Add optimistic audit entry
    setAuditEntries((prev) => [
      {
        id:        `opt_${Date.now()}`,
        event:     "CAPTURE_COMPLETED_BROWSER",
        actor:     "company",
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);
  }

  return (
    <div className="space-y-3">
      {/* Action / status area */}
      {status === "planned" && (
        <MilestoneFundButton
          milestoneId={milestoneId}
          milestoneTitle={milestoneTitle}
          budgetUsd={budgetUsd}
          onFunded={handleFunded}
        />
      )}

      {status === "funded" && (
        <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 px-4 py-3 text-sm space-y-1">
          <p className="font-medium text-green-700 dark:text-green-400">
            ✓ Payment captured — Held (simulated)
          </p>
          {fundResult && (
            <div className="text-xs text-muted-foreground space-y-0.5">
              {fundResult.grossUsd && <p>Gross: ${fundResult.grossUsd}</p>}
              {fundResult.feeUsd   && <p>PayPal fee: −${fundResult.feeUsd}</p>}
              {fundResult.netUsd   && (
                <p className="font-medium text-foreground">
                  Platform holds: ${fundResult.netUsd} USD
                </p>
              )}
              <p className="text-[11px] mt-1 text-muted-foreground">
                Order ID: <code className="font-mono">{fundResult.orderId}</code>
              </p>
              <p className="text-[11px] text-muted-foreground">
                Capture ID: <code className="font-mono">{fundResult.captureId}</code>
              </p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            This is a UI-level hold. The consultant will be paid via Payout when work is approved.
          </p>
        </div>
      )}

      {status === "pending_approval" && (
        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          ⏳ Awaiting payout approval
        </div>
      )}

      {status === "verifying" && (
        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <span className="inline-block mr-2 h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Payout processing…
        </div>
      )}

      {status === "paid" && (
        <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 px-4 py-3 text-sm font-medium text-green-700 dark:text-green-400">
          ✓ Paid — payout sent to consultant
        </div>
      )}

      {(status === "failed" || status === "returned") && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          ✗ Payout {status === "returned" ? "returned (unclaimed)" : "failed"} — contact support
        </div>
      )}

      {/* Mini event timeline */}
      {auditEntries.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
            Event log ({auditEntries.length})
          </summary>
          <ul className="mt-2 space-y-1 border-l-2 border-border pl-3">
            {auditEntries.slice(0, 8).map((entry) => (
              <li key={entry.id} className="text-muted-foreground">
                <span className="text-foreground font-mono">{entry.event}</span>
                <span className="mx-1">·</span>
                <span>{entry.actor}</span>
                <span className="mx-1">·</span>
                <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
