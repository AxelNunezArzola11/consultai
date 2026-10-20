"use client";

/**
 * VettingCard — Candidate card with trust score, matrix, and evidence links.
 *
 * Visual overhaul (AG Studio Midnight):
 * - Dark slate card surface, blue/emerald/amber/rose trust-score badges
 * - Soft emerald/slate tinted CAN/UNKNOWN matrix rows
 * - Ghost pill toggle buttons (no raw blue text links)
 * - Debug payload wrapped in a collapsible <details> accordion
 * - Clean shortlist/re-run action buttons with proper disabled states
 *
 * Design invariants (unchanged):
 * - Score and matrix come from the API (code-computed), never fabricated in UI
 * - All signals are linked to their source URL
 * - Human-review notice is always displayed
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
  /** Temporary debug payload — requirements sent to LLM + raw LLM output */
  debugPayload?: unknown;
}

// ---------------------------------------------------------------------------
// Matrix state → display
// ---------------------------------------------------------------------------

const MATRIX_STATE_CONFIG = {
  can: {
    icon: "✓",
    label: "Can",
    className: "bg-emerald-950/30 border-emerald-800/50 text-emerald-200",
    iconClass: "text-emerald-400",
  },
  partial: {
    icon: "~",
    label: "Partial",
    className: "bg-amber-950/20 border-amber-800/40 text-amber-200",
    iconClass: "text-amber-400",
  },
  no: {
    icon: "✗",
    label: "Cannot",
    className: "bg-rose-950/20 border-rose-800/40 text-rose-200",
    iconClass: "text-rose-400",
  },
  unknown: {
    icon: "?",
    label: "Unknown",
    className: "bg-slate-800/40 border-slate-700/50 text-slate-400",
    iconClass: "text-slate-500",
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
        <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border bg-emerald-950/80 text-emerald-400 border-emerald-800 text-2xl font-bold tabular-nums">
          {pct}
          <span className="text-xs font-normal opacity-70">pts</span>
        </div>
        <span className="text-[10px] text-emerald-500 font-medium">✓ Strong match</span>
      </div>
    );
  }
  if (pct >= 40) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border bg-amber-950/80 text-amber-400 border-amber-800 text-2xl font-bold tabular-nums">
          {pct}
          <span className="text-xs font-normal opacity-70">pts</span>
        </div>
        <span className="text-[10px] text-amber-500 font-medium">⚡ Moderate</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border bg-slate-800 text-slate-400 border-slate-700 text-2xl font-bold tabular-nums">
        {pct}
        <span className="text-xs font-normal opacity-70">pts</span>
      </div>
      <span className="text-[10px] text-slate-500 font-medium">○ Low signal</span>
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
        "font-medium text-xs px-2.5 py-1 rounded-md transition-colors",
        active
          ? "bg-primary/10 text-primary border border-primary/20"
          : "text-muted-foreground hover:text-foreground bg-muted/40 border border-transparent hover:border-border",
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
    <div className="flex items-center gap-1 flex-wrap">
      {counts.can > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-950/40 text-emerald-400 border border-emerald-800/50">
          ✓ {counts.can}
        </span>
      )}
      {counts.partial > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-950/30 text-amber-400 border border-amber-800/40">
          ~ {counts.partial}
        </span>
      )}
      {counts.no > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-rose-950/30 text-rose-400 border border-rose-800/40">
          ✗ {counts.no}
        </span>
      )}
      {counts.unknown > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-800/60 text-slate-500 border border-slate-700/50">
          ? {counts.unknown}
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
    <Card className="relative overflow-hidden bg-card border-border shadow-md hover:shadow-lg transition-all duration-200 group">
      {/* Top accent line — color coded by score */}
      <div
        className={[
          "absolute inset-x-0 top-0 h-0.5",
          score * 100 >= 75
            ? "bg-emerald-500"
            : score * 100 >= 40
              ? "bg-amber-500"
              : "bg-slate-600",
        ].join(" ")}
      />

      <CardHeader className="pb-2 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Name + rank */}
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-sm text-foreground truncate">{candidate.name}</h3>
              {candidate.rank && (
                <span className="text-[11px] font-medium text-muted-foreground bg-muted/60 border border-border px-1.5 py-0.5 rounded-full shrink-0">
                  #{candidate.rank}
                </span>
              )}
              {isShortlisted && (
                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/25 shrink-0">
                  Shortlisted ✓
                </span>
              )}
            </div>

            {/* Email */}
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{candidate.email}</p>

            {/* GitHub link */}
            {candidate.githubHandle && (
              <a
                href={`https://github.com/${candidate.githubHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:text-primary/80 transition-colors font-medium"
              >
                @{candidate.githubHandle} ↗
              </a>
            )}

            {/* LinkedIn link — display only */}
            {candidate.portfolioUrl && candidate.portfolioUrl.includes("linkedin.com") && (
              <div className="mt-0.5 flex items-center gap-1.5">
                <a
                  href={candidate.portfolioUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:text-primary/80 transition-colors font-medium"
                >
                  LinkedIn ↗
                </a>
                <span className="text-[10px] text-muted-foreground/70">(display only)</span>
              </div>
            )}
          </div>

          {/* Trust score badge */}
          <div className="shrink-0">
            <TrustScoreBadge score={score} />
            <div className="mt-1 flex justify-end">
              <GhostPill
                active={showBreakdown}
                onToggle={() => setShowBreakdown((v) => !v)}
                activeLabel="hide scoring"
                inactiveLabel="how scored"
              />
            </div>
          </div>
        </div>

        {/* Scoring breakdown panel */}
        {showBreakdown && scoreBreakdown && (
          <div className="mt-2 p-3 rounded-lg border border-border bg-muted/30 text-xs space-y-2">
            <p className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">
              Scoring Breakdown
            </p>
            <p className="text-muted-foreground text-[11px]">{scoringFormula}</p>
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              {(Object.entries(scoreBreakdown.weights) as [string, number][]).map(([type, weight]) => {
                const stat = scoreBreakdown.bySignalType[type as keyof typeof scoreBreakdown.bySignalType];
                return (
                  <div key={type} className="flex items-center justify-between gap-1 bg-muted/40 rounded px-2 py-1 border border-border/50">
                    <span className="text-muted-foreground capitalize text-[11px]">{type.replace("_", " ")}</span>
                    <span className="tabular-nums text-[11px] text-foreground/80 font-mono">
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
        {/* Matrix summary + toggle */}
        <div className="flex items-center justify-between gap-2">
          <MatrixSummaryBadges matrix={matrix} />
          <GhostPill
            active={showMatrix}
            onToggle={() => setShowMatrix((v) => !v)}
            activeLabel="hide matrix"
            inactiveLabel="full matrix"
          />
        </div>

        {/* Full matrix */}
        {showMatrix && matrix.length > 0 && (
          <div className="space-y-1 text-xs">
            <p className="text-muted-foreground uppercase tracking-wide text-[10px] font-semibold mb-1.5">
              Can/Can&apos;t-Do Matrix
            </p>
            {matrix.map((entry) => {
              const cfg = MATRIX_STATE_CONFIG[entry.state];
              return (
                <div
                  key={entry.requirementId}
                  className={`flex items-start gap-2 p-2 rounded-lg border ${cfg.className}`}
                >
                  <span className={`font-mono shrink-0 mt-0.5 text-sm ${cfg.iconClass}`}>
                    {cfg.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium leading-tight text-[12px]">{entry.requirementDescription}</p>
                    {entry.evidenceSummary && (
                      <p className="leading-tight mt-0.5 text-[11px] opacity-70">
                        {entry.evidenceSummary.slice(0, 120)}
                        {entry.evidenceSummary.length > 120 ? "…" : ""}
                      </p>
                    )}
                    {entry.state === "unknown" && (
                      <p className="text-[11px] opacity-60 italic mt-0.5">
                        No evidence found — unknown (not inferred)
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Signals (why this candidate) */}
        {signals.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground font-medium">
                {signals.length} evidence signals
              </span>
              <GhostPill
                active={showSignals}
                onToggle={() => setShowSignals((v) => !v)}
                activeLabel="hide evidence"
                inactiveLabel="why this candidate"
              />
            </div>

            {showSignals && (
              <div className="space-y-1.5 text-xs">
                <p className="text-muted-foreground uppercase tracking-wide text-[10px] font-semibold">
                  Evidence — every signal links to its source
                </p>
                {signals.map((sig) => (
                  <div key={sig.id} className="p-2 rounded-lg border border-border bg-muted/20 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-border bg-muted/50 text-muted-foreground">
                        {sig.signalType.replace("_", " ")}
                      </span>
                      <span className="text-muted-foreground text-[11px]">
                        {Math.round(sig.confidence * 100)}% conf
                      </span>
                      <a
                        href={sig.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:text-primary/80 truncate max-w-[180px] text-[11px] transition-colors"
                      >
                        {sig.sourceUrl.replace(/^https?:\/\//, "").slice(0, 40)}…
                      </a>
                    </div>
                    <p className="text-muted-foreground text-[11px]">{sig.extractedFact}</p>
                    <p className="font-mono text-[10px] italic text-muted-foreground/60">
                      &ldquo;{sig.quotedExcerpt}&rdquo;
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Portfolio quadrant diagram */}
        {candidate.githubHandle && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Portfolio chart</span>
              <GhostPill
                active={showDiagram}
                onToggle={() => setShowDiagram((v) => !v)}
                activeLabel="hide chart"
                inactiveLabel="quadrant chart"
              />
            </div>
            {showDiagram && (
              <div className="mt-1">
                {diagramResult.ok ? (
                  <GitHubDiagram
                    diagram={diagramResult.mermaid}
                    fallbackText="Portfolio quadrant chart"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground italic">{diagramResult.fallbackText}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Human-review notice — always visible */}
        <div className="text-xs text-amber-300/80 bg-amber-950/20 border border-amber-800/40 rounded-lg p-2.5">
          <span className="font-semibold text-amber-300">⚠ Human review required: </span>
          {humanReviewNotice}
        </div>

        {/* DEBUG: wrapped in collapsible accordion */}
        {debugPayload !== undefined && (
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wide hover:text-muted-foreground transition-colors py-1">
              🐛 Developer Debug Logs
            </summary>
            <pre
              style={{ background: "#0d1117", color: "#00ff41", fontSize: "10px", lineHeight: "1.4" }}
              className="overflow-auto rounded-lg p-3 max-h-72 whitespace-pre-wrap break-all mt-1 border border-emerald-900/30"
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
              "flex-1 text-xs rounded-lg px-3 py-2 font-medium transition-all duration-200",
              isShortlisted
                ? "bg-primary/10 text-primary border border-primary/20 cursor-default"
                : "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm shadow-primary/20 border border-transparent disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            {isShortlisted ? "Shortlisted ✓" : "Shortlist"}
          </button>
          <button
            onClick={handleRerun}
            disabled={isLoading}
            className="text-xs rounded-lg border border-border px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
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
            className="text-xs rounded-lg border border-border px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
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
