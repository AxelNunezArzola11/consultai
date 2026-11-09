"use client";

/**
 * VettingCard — Candidate card with trust score, matrix, and evidence links.
 *
 * Design invariants:
 * - Score and matrix come from the API (code-computed), never fabricated in UI
 * - All signals are linked to their source URL
 * - Page-level human-review notice is displayed on the vetting header; card keeps compact provenance
 */

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { MatrixEntry, Signal, ScoreBreakdown } from "@/lib/vetting/signals";
import { GitHubDiagram } from "@/components/vetting/GitHubDiagram";
import { buildQuadrantDiagram } from "@/lib/vetting/github-diagram";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VettingCardProps {
  candidate: {
    id: string;
    name: string;
    email: string;
    githubHandle: string | null;
    portfolioUrl: string | null;
    status: string;
    rank: number | null;
  };
  trustScore: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  matrix: MatrixEntry[];
  signals: Signal[];
  humanReviewNotice: string;
  scoringFormula: string;
  isShortlisted: boolean;
  projectId: string;
  onShortlist?: (candidateId: string) => void;
  onRerunVetting?: (candidateId: string) => void;
  debugPayload?: unknown;
}

// ---------------------------------------------------------------------------
// Matrix state → display
// ---------------------------------------------------------------------------

const MATRIX_STATE_CONFIG = {
  can: {
    icon: "✓",
    label: "Verified",
    className: "bg-emerald-950/35 border-emerald-700/50 text-emerald-200",
    iconClass: "text-emerald-400",
  },
  partial: {
    icon: "~",
    label: "Partial",
    className: "bg-amber-950/25 border-amber-700/40 text-amber-200",
    iconClass: "text-amber-400",
  },
  no: {
    icon: "✗",
    label: "Gap",
    className: "bg-rose-950/25 border-rose-700/40 text-rose-200",
    iconClass: "text-rose-400",
  },
  unknown: {
    icon: "?",
    label: "Unverified",
    className: "bg-slate-800/50 border-slate-700/60 text-slate-300",
    iconClass: "text-slate-400",
  },
} as const;

// ---------------------------------------------------------------------------
// Trust score badge
// ---------------------------------------------------------------------------

function TrustScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  if (pct >= 75) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="inline-flex items-baseline gap-1 px-2.5 py-1 rounded-lg border bg-emerald-950/70 text-emerald-300 border-emerald-700/70 font-mono text-2xl font-bold tabular-nums">
          {pct}
          <span className="text-[11px] font-normal text-emerald-400/80">pts</span>
        </div>
        <span className="text-[10px] text-emerald-400 font-medium">✓ Strong match</span>
      </div>
    );
  }
  if (pct >= 40) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="inline-flex items-baseline gap-1 px-2.5 py-1 rounded-lg border bg-amber-950/70 text-amber-300 border-amber-700/70 font-mono text-2xl font-bold tabular-nums">
          {pct}
          <span className="text-[11px] font-normal text-amber-400/80">pts</span>
        </div>
        <span className="text-[10px] text-amber-400 font-medium">⚡ Moderate</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="inline-flex items-baseline gap-1 px-2.5 py-1 rounded-lg border bg-slate-800 text-slate-300 border-slate-700 font-mono text-2xl font-bold tabular-nums">
        {pct}
        <span className="text-[11px] font-normal text-slate-400">pts</span>
      </div>
      <span className="text-[10px] text-slate-400 font-medium">○ Low signal</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ghost pill toggle button
// ---------------------------------------------------------------------------

function GhostPill({
  active,
  onToggle,
  activeLabel,
  inactiveLabel,
}: {
  active: boolean;
  onToggle: () => void;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={[
        "font-medium text-xs px-2.5 py-1 rounded-md transition-colors border",
        active
          ? "bg-blue-500/15 text-blue-300 border-blue-500/35"
          : "text-slate-300 hover:text-white bg-slate-800/70 border-slate-700/70 hover:border-slate-600",
      ].join(" ")}
    >
      {active ? activeLabel : inactiveLabel}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Matrix summary badges
// ---------------------------------------------------------------------------

function MatrixSummaryBadges({ matrix }: { matrix: MatrixEntry[] }) {
  const counts = {
    can: matrix.filter((e) => e.state === "can").length,
    partial: matrix.filter((e) => e.state === "partial").length,
    no: matrix.filter((e) => e.state === "no").length,
    unknown: matrix.filter((e) => e.state === "unknown").length,
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {counts.can > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-emerald-950/50 text-emerald-300 border border-emerald-700/60 tabular-nums">
          ✓ {counts.can} Verified
        </span>
      )}
      {counts.partial > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-amber-950/40 text-amber-300 border border-amber-700/50 tabular-nums">
          ~ {counts.partial} Partial
        </span>
      )}
      {counts.no > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-rose-950/40 text-rose-300 border border-rose-700/50 tabular-nums">
          ✗ {counts.no} Gap
        </span>
      )}
      {counts.unknown > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-slate-800/80 text-slate-300 border border-slate-700 tabular-nums">
          {counts.unknown} Unverified
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VettingCard
// ---------------------------------------------------------------------------

export function VettingCard({
  candidate,
  trustScore,
  scoreBreakdown,
  matrix,
  signals,
  humanReviewNotice,
  scoringFormula,
  isShortlisted,
  projectId,
  onShortlist,
  onRerunVetting,
  debugPayload,
}: VettingCardProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showMatrix, setShowMatrix] = useState(false);
  const [showSignals, setShowSignals] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPdfLoading, setIsPdfLoading] = useState(false);

  const score = trustScore ?? 0;

  const stackMatch = scoreBreakdown?.bySignalType?.github_repo?.avgConfidence ?? 0;
  const diagramResult = buildQuadrantDiagram([
    {
      label: candidate.githubHandle ?? candidate.name,
      trustScore: score,
      stackMatch,
    },
  ]);

  async function handleShortlist() {
    setIsLoading(true);
    try {
      const res = await fetch("/api/candidates/shortlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: candidate.id, projectId }),
      });
      if (res.ok) {
        onShortlist?.(candidate.id);
      }
    } finally {
      setIsLoading(false);
    }
  }

  const handleExportPdf = useCallback(async () => {
    setIsPdfLoading(true);
    try {
      const { generateExecutivePdf, downloadPdf } = await import("@/lib/pdf/executive-report");
      const bytes = await generateExecutivePdf({
        projectTitle: `Project ${projectId}`,
        projectId,
        candidates: [{
          id:            candidate.id,
          name:          candidate.name,
          email:         candidate.email,
          githubHandle:  candidate.githubHandle,
          trustScore:    score,
          scoreBreakdown,
          matrix,
          signals,
        }],
        milestones: [],
        humanReviewNotice,
      });
      const safeName = (candidate.githubHandle ?? candidate.name).replace(/[^a-z0-9]/gi, "_").slice(0, 40);
      downloadPdf(bytes, `executive-report-${safeName}.pdf`);
      toast.success("Executive PDF downloaded");
    } catch (err) {
      toast.error(`PDF export failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsPdfLoading(false);
    }
  }, [candidate, projectId, score, scoreBreakdown, matrix, signals, humanReviewNotice]);

  async function handleRerun() {
    setIsLoading(true);
    try {
      await fetch("/api/agent/vetting/consent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: candidate.id, projectId }),
      });
      const res = await fetch("/api/agent/vetting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: candidate.id, projectId }),
      });
      if (res.ok) {
        onRerunVetting?.(candidate.id);
      } else {
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
        const errMsg = String(errBody.error ?? `HTTP ${res.status} ${res.statusText}`);
        toast.error(`Vetting failed: ${errMsg}`);
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className="relative overflow-hidden rounded-xl bg-[#0f141e] border-slate-800 shadow-md transition-colors hover:border-slate-700 group">
      <CardHeader className="pb-3 pt-5">
        <div className="flex items-start justify-between gap-3 pt-2">
          <div className="min-w-0 flex-1">
            {/* Name + rank */}
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-base text-white truncate">{candidate.name}</h3>
              {candidate.rank && (
                <span className="font-mono text-[11px] font-semibold tabular-nums text-slate-300 bg-slate-800/90 border border-slate-700 px-1.5 py-0.5 rounded shrink-0">
                  #{candidate.rank}
                </span>
              )}
              {isShortlisted && (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30 shrink-0">
                  Shortlisted ✓
                </span>
              )}
            </div>

            {/* Email */}
            <p className="text-xs text-slate-300 mt-0.5 truncate">{candidate.email}</p>

            {/* GitHub link */}
            {candidate.githubHandle && (
              <a
                href={`https://github.com/${candidate.githubHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-1 text-xs text-blue-400 hover:text-blue-300 transition-colors font-mono font-medium"
              >
                @{candidate.githubHandle} ↗
              </a>
            )}

            {/* LinkedIn link — display only */}
            {candidate.portfolioUrl && candidate.portfolioUrl.includes("linkedin.com") && (
              <div className="mt-1 flex items-center gap-1.5">
                <a
                  href={candidate.portfolioUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
                >
                  LinkedIn ↗
                </a>
                <span className="text-[10px] text-slate-400">(display only)</span>
              </div>
            )}
          </div>

          {/* Trust score badge */}
          <div className="shrink-0">
            <TrustScoreBadge score={score} />
          </div>
        </div>

        {/* Scoring breakdown panel */}
        {showBreakdown && scoreBreakdown && (
          <div className="mt-3 p-3 rounded-lg border border-slate-800 bg-[#0b0f17] text-xs space-y-2">
            <p className="font-semibold text-slate-200 text-xs">
              Scoring Breakdown
            </p>
            <p className="text-slate-300 text-[11px] leading-relaxed">{scoringFormula}</p>
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              {(Object.entries(scoreBreakdown.weights) as [string, number][]).map(([type, weight]) => {
                const stat = scoreBreakdown.bySignalType[type as keyof typeof scoreBreakdown.bySignalType];
                return (
                  <div key={type} className="flex items-center justify-between gap-1 bg-slate-900 rounded px-2.5 py-1 border border-slate-800">
                    <span className="text-slate-300 capitalize text-[11px]">{type.replace("_", " ")}</span>
                    <span className="tabular-nums text-[11px] text-white font-mono">
                      {Math.round(weight * 100)}%
                      {stat ? ` · ${stat.count}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {/* Matrix summary + inspection toggles */}
        <div className="rounded-lg border border-slate-800/80 bg-[#0b0f17] p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <MatrixSummaryBadges matrix={matrix} />
            <span className="text-xs text-slate-300 font-mono tabular-nums">
              {signals.length} signal{signals.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-800/80">
            <GhostPill
              active={showMatrix}
              onToggle={() => setShowMatrix((v) => !v)}
              activeLabel="Hide Matrix"
              inactiveLabel="Full Matrix"
            />
            {signals.length > 0 && (
              <GhostPill
                active={showSignals}
                onToggle={() => setShowSignals((v) => !v)}
                activeLabel="Hide Evidence"
                inactiveLabel="Evidence Signals"
              />
            )}
            <GhostPill
              active={showBreakdown}
              onToggle={() => setShowBreakdown((v) => !v)}
              activeLabel="Hide Weights"
              inactiveLabel="How Scored"
            />
            {candidate.githubHandle && (
              <GhostPill
                active={showDiagram}
                onToggle={() => setShowDiagram((v) => !v)}
                activeLabel="Hide Chart"
                inactiveLabel="Quadrant"
              />
            )}
          </div>
        </div>

        {/* Full matrix */}
        {showMatrix && matrix.length > 0 && (
          <div className="space-y-1.5 text-xs">
            <p className="text-slate-300 text-xs font-semibold">
              Requirement Verification Matrix
            </p>
            {matrix.map((entry) => {
              const cfg = MATRIX_STATE_CONFIG[entry.state];
              return (
                <div
                  key={entry.requirementId}
                  className={`flex items-start gap-2 p-2.5 rounded-lg border ${cfg.className}`}
                >
                  <span className={`font-mono shrink-0 mt-0.5 text-sm ${cfg.iconClass}`}>
                    {cfg.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium leading-tight text-xs">{entry.requirementDescription}</p>
                    {entry.evidenceSummary && (
                      <p className="leading-tight mt-0.5 text-[11px] opacity-85">
                        {entry.evidenceSummary.slice(0, 120)}
                        {entry.evidenceSummary.length > 120 ? "…" : ""}
                      </p>
                    )}
                    {entry.state === "unknown" && (
                      <p className="text-[11px] opacity-75 mt-0.5">
                        No public repository evidence found — not inferred
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Signals (why this candidate) */}
        {showSignals && signals.length > 0 && (
          <div className="space-y-1.5 text-xs">
            <p className="text-slate-300 text-xs font-semibold">
              Verified Public Evidence Signals
            </p>
            {signals.map((sig) => (
              <div key={sig.id} className="p-2.5 rounded-lg border border-slate-800 bg-[#0b0f17] space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-200">
                    {sig.signalType.replace("_", " ")}
                  </span>
                  <span className="text-emerald-400 font-mono text-[11px] tabular-nums">
                    {Math.round(sig.confidence * 100)}% conf
                  </span>
                  <a
                    href={sig.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 truncate max-w-[180px] text-[11px] transition-colors"
                  >
                    {sig.sourceUrl.replace(/^https?:\/\//, "").slice(0, 40)}…
                  </a>
                </div>
                <p className="text-slate-200 text-xs">{sig.extractedFact}</p>
                <p className="font-mono text-[11px] text-slate-400">
                  &ldquo;{sig.quotedExcerpt}&rdquo;
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Portfolio quadrant diagram */}
        {showDiagram && candidate.githubHandle && (
          <div className="mt-1">
            {diagramResult.ok ? (
              <GitHubDiagram
                diagram={diagramResult.mermaid}
                fallbackText="Portfolio quadrant chart"
              />
            ) : (
              <p className="text-xs text-slate-400">{diagramResult.fallbackText}</p>
            )}
          </div>
        )}

        {/* DEBUG: wrapped in collapsible accordion */}
        {debugPayload !== undefined && (
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-[11px] font-mono text-slate-400 hover:text-slate-200 transition-colors py-1">
              Developer Debug Trace
            </summary>
            <pre
              style={{ background: "#090c12", color: "#34d399", fontSize: "10px", lineHeight: "1.4" }}
              className="overflow-auto rounded-lg p-3 max-h-60 whitespace-pre-wrap break-all mt-1 border border-slate-800"
            >
              {JSON.stringify(debugPayload, null, 2)}
            </pre>
          </details>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <button
            onClick={handleShortlist}
            disabled={isLoading || isShortlisted}
            className={[
              "flex-1 text-xs rounded-lg px-3 py-2 font-semibold transition-all",
              isShortlisted
                ? "bg-blue-500/15 text-blue-300 border border-blue-500/30 cursor-default"
                : "bg-blue-600 text-white hover:bg-blue-500 shadow-sm shadow-blue-600/20 border border-transparent disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            {isShortlisted ? "Shortlisted ✓" : "Shortlist"}
          </button>
          <button
            onClick={handleRerun}
            disabled={isLoading}
            className="text-xs font-medium rounded-lg border border-slate-700/80 bg-[#0b0f17] px-3 py-2 text-slate-200 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Re-run vetting with fresh data"
          >
            {isLoading ? (
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Running…
              </span>
            ) : (
              "Re-run"
            )}
          </button>
          <button
            onClick={handleExportPdf}
            disabled={isPdfLoading}
            className="text-xs font-medium rounded-lg border border-slate-700/80 bg-[#0b0f17] px-3 py-2 text-slate-200 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export Executive PDF report"
          >
            {isPdfLoading ? (
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Exporting…
              </span>
            ) : (
              "↓ PDF"
            )}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
