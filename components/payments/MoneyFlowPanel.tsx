"use client";

/**
 * MoneyFlowPanel — Step 6 money-flow UI
 *
 * Animated Company → Held (simulated) → Freelancer flow,
 * driven by stored milestone status via polling every 2-3 s.
 *
 * States mapped to visual stages:
 *   planned          → "Awaiting funding" (Company highlighted)
 *   funded           → "Held (simulated)" (Held node active, green)
 *   pending_approval → "Awaiting approval" (Held node pulsing amber)
 *   verifying        → "Sending" (arrow animating)
 *   paid             → "Paid" (Freelancer highlighted green)
 *   failed           → "Failed" (red, retry note)
 *   returned         → "Returned" (amber, funds back to company)
 *
 * Polling: every 2.5 s via setInterval + GET /api/milestone-status/[id].
 *
 * Approval card: inline form with email + note + Release Payout button.
 * Event timeline: expandable from audit log.
 *
 * Phase 1 rules:
 *   - "Held (simulated)" label — not "PayPal escrow"
 *   - Sandbox badge always visible when NEXT_PUBLIC_PAYPAL_ENV = "sandbox"
 *   - No SSE — polling only (SSE 250 s test on Vercel never run)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { MilestoneFundButton, type FundResult } from "./MilestoneFundButton";

// ── Types ────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id:        string;
  event:     string;
  actor:     string;
  createdAt: string;
}

interface PaymentSummary {
  id:          string;
  status:      string;
  grossUsd:    string | null;
  feeUsd:      string | null;
  netUsd:      string | null;
  payoutFeeUsd: string | null;
}

interface MilestoneState {
  milestoneId:         string;
  status:              string;
  captureGrossUsd:     string | null;
  captureFeeUsd:       string | null;
  captureNetUsd:       string | null;
  currency:            string | null;
  paypalOrderId:       string | null;
  paypalCaptureId:     string | null;
  paypalPayoutBatchId: string | null;
  payment:             PaymentSummary | null;
  audit:               AuditEntry[];
}

interface Props {
  milestoneId:     string;
  milestoneTitle:  string;
  budgetUsd:       string;
  initialStatus:   string;
  initialGrossUsd: string | null;
  initialFeeUsd:   string | null;
  initialNetUsd:   string | null;
  initialCurrency: string | null;
  initialAudit:    AuditEntry[];
}

// ── Stage helpers ────────────────────────────────────────────────────────────

type Stage =
  | "idle"
  | "funding"
  | "held"
  | "pending_approval"
  | "sending"
  | "processing"
  | "paid"
  | "failed"
  | "returned";

function statusToStage(status: string): Stage {
  switch (status) {
    case "planned":          return "idle";
    case "funded":           return "held";
    case "pending_approval": return "pending_approval";
    case "verifying":        return "sending";
    case "paid":             return "paid";
    case "failed":           return "failed";
    case "returned":         return "returned";
    default:                 return "idle";
  }
}

const STAGE_LABEL: Record<Stage, string> = {
  idle:             "Awaiting funding",
  funding:          "Processing payment…",
  held:             "Held (simulated)",
  pending_approval: "Awaiting approval",
  sending:          "Sending payout",
  processing:       "Processing payout",
  paid:             "Paid",
  failed:           "Failed",
  returned:         "Returned",
};

const isSandbox = (process.env.NEXT_PUBLIC_PAYPAL_ENV ?? "sandbox") === "sandbox";

// ── Polling interval — 2.5 s ────────────────────────────────────────────────

const POLL_MS = 2500;

// Terminal states where polling can stop
const TERMINAL: Stage[] = ["paid", "failed", "returned"];

// ── Component ────────────────────────────────────────────────────────────────

export function MoneyFlowPanel({
  milestoneId,
  milestoneTitle,
  budgetUsd,
  initialStatus,
  initialGrossUsd,
  initialFeeUsd,
  initialNetUsd,
  initialCurrency,
  initialAudit,
}: Props) {
  const [state, setState] = useState<MilestoneState>({
    milestoneId,
    status:              initialStatus,
    captureGrossUsd:     initialGrossUsd,
    captureFeeUsd:       initialFeeUsd,
    captureNetUsd:       initialNetUsd,
    currency:            initialCurrency,
    paypalOrderId:       null,
    paypalCaptureId:     null,
    paypalPayoutBatchId: null,
    payment:             null,
    audit:               initialAudit,
  });
  const [loading, setLoading]             = useState(false);
  const [pollError, setPollError]         = useState(false);
  const [approveLoading, setApproveLoading] = useState(false);
  const [recipientEmail, setEmail]        = useState("");
  const [note, setNote]                   = useState("");
  const [auditOpen, setAuditOpen]         = useState(false);

  const prevStatusRef = useRef(initialStatus);
  const stageRef      = useRef<Stage>(statusToStage(initialStatus));

  const stage = statusToStage(state.status);
  stageRef.current = stage;

  // ── Poll ──────────────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    try {
      const res  = await fetch(`/api/milestone-status/${milestoneId}`, { cache: "no-store" });
      if (!res.ok) { setPollError(true); return; }
      const data = await res.json() as MilestoneState;
      setPollError(false);

      // Only update state when something changed
      setState((prev) => {
        if (prev.status !== data.status || prev.audit.length !== data.audit.length) {
          return data;
        }
        return prev;
      });

      // Toast on state change
      if (prevStatusRef.current !== data.status) {
        const from = prevStatusRef.current;
        const to   = data.status;
        prevStatusRef.current = to;

        if (to === "funded")           toast.success("Payment captured — milestone held!");
        if (to === "pending_approval") toast.info("Awaiting payout approval");
        if (to === "verifying")        toast.info("Payout submitted — processing");
        if (to === "paid")             toast.success("Payout sent to consultant!");
        if (to === "failed")           toast.error(`Payout failed (was ${from})`);
        if (to === "returned")         toast.warning("Payout returned (unclaimed)");
      }
    } catch {
      setPollError(true);
    }
  }, [milestoneId]);

  useEffect(() => {
    // Only poll when not in a terminal state
    if (TERMINAL.includes(stage)) return;

    const id = setInterval(() => { void poll(); }, POLL_MS);
    return () => clearInterval(id);
  }, [poll, stage]);

  // ── Fund button callback ───────────────────────────────────────────────────
  function handleFunded(result: FundResult) {
    setState((prev) => ({
      ...prev,
      status:          "funded",
      captureGrossUsd: result.grossUsd,
      captureFeeUsd:   result.feeUsd,
      captureNetUsd:   result.netUsd,
      payment:         prev.payment,
      audit: [
        {
          id:        `opt_${Date.now()}`,
          event:     "CAPTURE_COMPLETED_BROWSER",
          actor:     "company",
          createdAt: new Date().toISOString(),
        },
        ...prev.audit,
      ],
    }));
    prevStatusRef.current = "funded";
  }

  // ── Payout / Approve handler ───────────────────────────────────────────────
  async function handleApprove() {
    if (!recipientEmail) {
      toast.error("Enter the freelancer's PayPal email first");
      return;
    }
    setApproveLoading(true);
    try {
      const res  = await fetch("/api/paypal/payout", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          paymentId: state.payment?.id,
          milestoneId,
          recipientEmail,
          note,
        }),
      });
      const data = await res.json() as Record<string, unknown>;

      if (!res.ok) {
        toast.error(`Payout error: ${String(data.error ?? "unknown")}`);
        return;
      }

      if (data.status === "pending_approval") {
        toast.info(`Approval required — amount $${state.captureNetUsd} exceeds auto-approve threshold`);
      } else {
        toast.success(
          data.isReplay
            ? "↩ Idempotent replay — original payout, no double payment"
            : `Payout issued — batch ${String(data.batchId)}`
        );
      }
      // Refresh state immediately
      await poll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Payout failed");
    } finally {
      setApproveLoading(false);
    }
  }

  // ── Ledger values ──────────────────────────────────────────────────────────
  const grossUsd  = state.payment?.grossUsd    ?? state.captureGrossUsd;
  const feeUsd    = state.payment?.feeUsd      ?? state.captureFeeUsd;
  const netUsd    = state.payment?.netUsd      ?? state.captureNetUsd;
  const currency  = state.currency ?? "USD";
  const payoutFee = state.payment?.payoutFeeUsd ?? null;

  // ── Node colours ──────────────────────────────────────────────────────────
  const companyActive   = stage === "idle" || stage === "funding";
  const heldActive      = stage === "held" || stage === "pending_approval" || stage === "sending" || stage === "processing";
  const freelancerActive = stage === "paid";
  const anyFailed       = stage === "failed" || stage === "returned";

  return (
    <div className="space-y-4">
      {/* ── Sandbox badge ─────────────────────────────────────────────── */}
      {isSandbox && (
        <div className="flex justify-end">
          <span className="inline-flex items-center rounded-full border border-amber-400
            bg-amber-50 dark:bg-amber-950/30 px-3 py-1 text-[11px] font-medium
            text-amber-700 dark:text-amber-400">
            Sandbox mode
          </span>
        </div>
      )}

      {/* ── Animated money-flow diagram ───────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4">
        <p className="text-xs text-muted-foreground mb-4 font-medium uppercase tracking-wide">
          Payment flow
        </p>

        <div className="flex items-center gap-2 justify-between flex-wrap sm:flex-nowrap">
          {/* Company node */}
          <FlowNode
            label="Company"
            sublabel={companyActive && stage === "funding" ? "Paying…" : "Pays"}
            active={companyActive}
            done={!companyActive && !anyFailed}
          />

          {/* Arrow → Held */}
          <FlowArrow
            active={stage === "funding"}
            done={stage !== "idle" && stage !== "funding" && stage !== "failed" && stage !== "returned"}
          />

          {/* Held node */}
          <FlowNode
            label="Held (simulated)"
            sublabel={
              stage === "held"             ? "Captured ✓" :
              stage === "pending_approval" ? "Awaiting approval…" :
              stage === "sending"          ? "Releasing…" :
              stage === "processing"       ? "Processing…" :
              "—"
            }
            active={heldActive}
            done={stage === "paid"}
            pulsing={stage === "pending_approval"}
            amber={stage === "pending_approval"}
          />

          {/* Arrow → Freelancer */}
          <FlowArrow
            active={stage === "sending" || stage === "processing"}
            done={stage === "paid"}
            animating={stage === "sending" || stage === "processing"}
          />

          {/* Freelancer node */}
          <FlowNode
            label="Consultant"
            sublabel={stage === "paid" ? "Received ✓" : "Receives"}
            active={freelancerActive}
            done={freelancerActive}
          />
        </div>

        {/* Stage label */}
        <div className="mt-4 flex items-center gap-2">
          {(stage === "sending" || stage === "processing") && (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2
              border-current border-t-transparent text-blue-500" />
          )}
          <span className={`text-sm font-medium ${
            stage === "paid"             ? "text-green-600 dark:text-green-400" :
            stage === "failed"           ? "text-destructive" :
            stage === "returned"         ? "text-amber-600 dark:text-amber-400" :
            stage === "pending_approval" ? "text-amber-600 dark:text-amber-400" :
            "text-foreground"
          }`}>
            {STAGE_LABEL[stage]}
          </span>

          {pollError && (
            <span className="text-xs text-muted-foreground ml-auto">
              ⚠ Poll error — retrying
            </span>
          )}
        </div>

        {/* Failed / returned message */}
        {stage === "failed" && (
          <p className="text-xs text-destructive mt-2">
            The payout failed. Contact support or retry funding.
          </p>
        )}
        {stage === "returned" && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
            Funds returned — the consultant's PayPal account may be unregistered.
          </p>
        )}
      </div>

      {/* ── Fund button (planned state only) ─────────────────────────── */}
      {state.status === "planned" && (
        <div className="rounded-xl border bg-card p-4 space-y-2">
          <p className="text-sm font-medium">Fund this milestone</p>
          <p className="text-xs text-muted-foreground">
            Budget: <strong className="text-foreground">${Number(budgetUsd).toLocaleString()} USD</strong>
          </p>
          <MilestoneFundButton
            milestoneId={milestoneId}
            milestoneTitle={milestoneTitle}
            budgetUsd={budgetUsd}
            onFunded={handleFunded}
          />
        </div>
      )}

      {/* ── Ledger ───────────────────────────────────────────────────── */}
      {(grossUsd || netUsd) && (
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-3 font-medium uppercase tracking-wide">
            Ledger
          </p>
          <div className="space-y-1 text-xs">
            {grossUsd && (
              <LedgerRow
                label="Company paid (gross)"
                value={`$${Number(grossUsd).toFixed(2)} ${currency}`}
              />
            )}
            {feeUsd && (
              <LedgerRow
                label="PayPal Orders fee"
                value={`−$${Number(feeUsd).toFixed(2)}`}
                red
              />
            )}
            {netUsd && (
              <LedgerRow
                label="Platform holds (simulated)"
                value={`$${Number(netUsd).toFixed(2)} ${currency}`}
                strong
                green
                separator
              />
            )}
            {payoutFee && (
              <LedgerRow
                label="PayPal Payout fee (observed)"
                value={`−$${Number(payoutFee).toFixed(2)}`}
                red
              />
            )}
          </div>
        </div>
      )}

      {/* ── Approval card (funded / pending_approval states) ─────────── */}
      {(state.status === "funded" || state.status === "pending_approval") && state.payment && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">Release payout</p>
            <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5">
              {milestoneTitle}
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            Amount:{" "}
            <strong className="text-foreground">
              ${netUsd ? Number(netUsd).toFixed(2) : "—"} {currency}
            </strong>
            <span className="ml-1 text-muted-foreground">(net after PayPal fee)</span>
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Consultant PayPal email
              </label>
              <input
                type="email"
                value={recipientEmail}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="consultant@example.com"
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm
                  focus:outline-none focus:ring-2 focus:ring-ring"
              />
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

          <button
            onClick={() => { void handleApprove(); }}
            disabled={approveLoading || !recipientEmail}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium
              bg-green-600 text-white hover:bg-green-700 disabled:opacity-50
              disabled:cursor-not-allowed transition-colors"
          >
            {approveLoading ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2
                  border-white border-t-transparent" />
                Sending…
              </>
            ) : (
              "Release Payout"
            )}
          </button>

          <p className="text-[11px] text-muted-foreground">
            Payout via PayPal Payouts API · Sandbox only · Consultant receives full net amount
          </p>
        </div>
      )}

      {/* ── Paid state ───────────────────────────────────────────────── */}
      {state.status === "paid" && (
        <div className="rounded-xl border border-green-200 bg-green-50
          dark:border-green-900 dark:bg-green-950/30 p-4 text-sm space-y-1">
          <p className="font-medium text-green-700 dark:text-green-400">
            ✓ Payout complete — consultant paid
          </p>
          {netUsd && (
            <p className="text-xs text-muted-foreground">
              Amount: ${Number(netUsd).toFixed(2)} {currency}
            </p>
          )}
        </div>
      )}

      {/* ── Event timeline ───────────────────────────────────────────── */}
      {state.audit.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <button
            onClick={() => setAuditOpen((o) => !o)}
            className="w-full flex items-center justify-between text-xs font-medium
              text-muted-foreground hover:text-foreground transition-colors"
          >
            <span>Event timeline ({state.audit.length})</span>
            <span>{auditOpen ? "▲" : "▼"}</span>
          </button>

          {auditOpen && (
            <ul className="mt-3 space-y-2 border-l-2 border-border pl-3">
              {state.audit.map((entry) => (
                <li key={entry.id} className="text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono font-medium text-foreground">
                      {entry.event}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{entry.actor}</span>
                    <span className="text-muted-foreground ml-auto">
                      {new Date(entry.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Loading skeleton overlay — only for initial load */}
      {loading && (
        <div className="rounded-xl border bg-card p-4 space-y-2 animate-pulse">
          <div className="h-3 w-1/3 rounded bg-muted" />
          <div className="h-3 w-2/3 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted" />
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface FlowNodeProps {
  label:    string;
  sublabel: string;
  active:   boolean;
  done?:    boolean;
  pulsing?: boolean;
  amber?:   boolean;
}

function FlowNode({ label, sublabel, active, done, pulsing, amber }: FlowNodeProps) {
  const base = "flex flex-col items-center justify-center rounded-xl border px-3 py-3 min-w-[80px] text-center transition-all duration-300";
  const colour =
    done    ? "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30" :
    amber   ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30" :
    active  ? "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30" :
    "border-border bg-muted/30";

  return (
    <div className={`${base} ${colour} ${pulsing ? "animate-pulse" : ""}`}>
      <span className={`text-xs font-semibold ${
        done ? "text-green-700 dark:text-green-400" :
        amber ? "text-amber-700 dark:text-amber-400" :
        active ? "text-blue-700 dark:text-blue-400" :
        "text-muted-foreground"
      }`}>
        {label}
      </span>
      <span className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</span>
    </div>
  );
}

interface FlowArrowProps {
  active?:    boolean;
  done?:      boolean;
  animating?: boolean;
}

function FlowArrow({ active, done, animating }: FlowArrowProps) {
  const colour =
    done    ? "text-green-500" :
    active  ? "text-blue-500" :
    "text-muted-foreground/40";

  return (
    <div className={`flex-1 flex items-center justify-center min-w-[24px] ${colour}`}>
      <svg
        width="32" height="14" viewBox="0 0 32 14" fill="none"
        className={animating ? "animate-pulse" : ""}
      >
        <path
          d="M0 7H28M28 7L22 1M28 7L22 13"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

interface LedgerRowProps {
  label:      string;
  value:      string;
  red?:       boolean;
  green?:     boolean;
  strong?:    boolean;
  separator?: boolean;
}

function LedgerRow({ label, value, red, green, strong, separator }: LedgerRowProps) {
  return (
    <div className={`flex justify-between items-baseline gap-2 ${separator ? "border-t pt-1.5 mt-1.5" : ""}`}>
      <span className="text-muted-foreground truncate">{label}</span>
      <span className={`shrink-0 font-mono ${
        strong && green ? "font-semibold text-green-600 dark:text-green-400" :
        red ? "text-destructive" :
        "text-foreground"
      }`}>
        {value}
      </span>
    </div>
  );
}
