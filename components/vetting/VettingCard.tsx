"use client";

/**
 * VettingCard — Candidate card with trust score, matrix, and evidence links.
 *
 * Features:
 * - Trust score displayed prominently with colored ring
 * - Scoring breakdown on hover ("how this is scored" panel)
 * - Can/can't-do matrix with state icons
 * - Evidence signals with source links
 * - "Why this candidate" explanation
 * - Human-review notice always visible
 * - Shortlist button (feeds Phase 4 pipeline)
 * - Re-run vetting button
 *
 * Design invariants:
 * - Score and matrix come from the API (code-computed), never fabricated in UI
 * - All signals are linked to their source URL
 * - Human-review notice is always displayed
 */

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { MatrixEntry, Signal, ScoreBreakdown } from "@/lib/vetting/signals";

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
}

// ---------------------------------------------------------------------------
// Matrix state → display
// ---------------------------------------------------------------------------

const MATRIX_STATE_CONFIG = {
  can: { icon: "✓", label: "Can", className: "text-green-700 bg-green-50 border-green-200" },
  partial: { icon: "~", label: "Partial", className: "text-yellow-700 bg-yellow-50 border-yellow-200" },
  no: { icon: "✗", label: "Cannot", className: "text-red-700 bg-red-50 border-red-200" },
  unknown: { icon: "?", label: "Unknown", className: "text-slate-500 bg-slate-50 border-slate-200" },
} as const;

// ---------------------------------------------------------------------------
// Trust score ring color
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score >= 0.7) return "text-green-700";
  if (score >= 0.4) return "text-yellow-600";
  return "text-red-600";
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
}: VettingCardProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showMatrix, setShowMatrix] = useState(false);
  const [showSignals, setShowSignals] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const score = trustScore ?? 0;
  const scorePercent = Math.round(score * 100);

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
      }
    } finally {
      setIsLoading(false);
    }
  }

  const canCount = matrix.filter((e) => e.state === "can").length;
  const partialCount = matrix.filter((e) => e.state === "partial").length;
  const cannotCount = matrix.filter((e) => e.state === "no").length;
  const unknownCount = matrix.filter((e) => e.state === "unknown").length;

  return (
    <Card className="relative">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-sm truncate">{candidate.name}</h3>
              {candidate.rank && (
                <Badge variant="secondary" className="text-xs shrink-0">
                  #{candidate.rank}
                </Badge>
              )}
              {isShortlisted && (
                <Badge className="text-xs shrink-0 bg-blue-600">Shortlisted</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{candidate.email}</p>
            {candidate.githubHandle && (
              <a
                href={`https://github.com/${candidate.githubHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                @{candidate.githubHandle}
              </a>
            )}
            {/* LinkedIn link — display only, never fetched */}
            {candidate.portfolioUrl && candidate.portfolioUrl.includes("linkedin.com") && (
              <div className="mt-0.5">
                <a
                  href={candidate.portfolioUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline"
                >
                  LinkedIn ↗
                </a>
                <span className="text-xs text-muted-foreground ml-1">(display only — not fetched)</span>
              </div>
            )}
          </div>

          {/* Trust score */}
          <div className="text-right shrink-0">
            <div
              className={`text-2xl font-bold tabular-nums ${scoreColor(score)}`}
              title={scoringFormula}
            >
              {scorePercent}
            </div>
            <div className="text-xs text-muted-foreground">trust</div>
            <button
              onClick={() => setShowBreakdown((v) => !v)}
              className="text-xs text-blue-600 hover:underline mt-0.5"
            >
              {showBreakdown ? "hide" : "how scored"}
            </button>
          </div>
        </div>

        {/* Scoring breakdown panel */}
        {showBreakdown && scoreBreakdown && (
          <div className="mt-2 p-2 rounded border bg-muted text-xs space-y-1">
            <p className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">
              How this is scored
            </p>
            <p className="text-muted-foreground">{scoringFormula}</p>
            <div className="grid grid-cols-2 gap-1 mt-1">
              {(Object.entries(scoreBreakdown.weights) as [string, number][]).map(([type, weight]) => {
                const stat = scoreBreakdown.bySignalType[type as keyof typeof scoreBreakdown.bySignalType];
                return (
                  <div key={type} className="flex items-center justify-between gap-1">
                    <span className="text-muted-foreground capitalize">{type.replace("_", " ")}</span>
                    <span className="tabular-nums">
                      w={weight.toFixed(2)}
                      {stat ? ` · ${stat.count}sig · ${Math.round(stat.avgConfidence * 100)}%` : " · 0sig"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {/* Matrix summary */}
        <div className="flex items-center gap-1 flex-wrap">
          {canCount > 0 && (
            <Badge className="text-xs bg-green-100 text-green-800 border-green-200">
              ✓ {canCount} can
            </Badge>
          )}
          {partialCount > 0 && (
            <Badge className="text-xs bg-yellow-100 text-yellow-800 border-yellow-200">
              ~ {partialCount} partial
            </Badge>
          )}
          {cannotCount > 0 && (
            <Badge className="text-xs bg-red-100 text-red-800 border-red-200">
              ✗ {cannotCount} cannot
            </Badge>
          )}
          {unknownCount > 0 && (
            <Badge variant="outline" className="text-xs">
              ? {unknownCount} unknown
            </Badge>
          )}
          <button
            onClick={() => setShowMatrix((v) => !v)}
            className="text-xs text-blue-600 hover:underline ml-1"
          >
            {showMatrix ? "hide matrix" : "full matrix"}
          </button>
        </div>

        {/* Full matrix */}
        {showMatrix && matrix.length > 0 && (
          <div className="space-y-1 text-xs">
            <p className="text-muted-foreground uppercase tracking-wide text-[10px] font-semibold">
              Can/Can&apos;t-Do Matrix
            </p>
            {matrix.map((entry) => {
              const cfg = MATRIX_STATE_CONFIG[entry.state];
              return (
                <div
                  key={entry.requirementId}
                  className={`flex items-start gap-2 p-1.5 rounded border ${cfg.className}`}
                >
                  <span className="font-mono shrink-0">{cfg.icon}</span>
                  <div className="min-w-0">
                    <p className="font-medium leading-tight">{entry.requirementDescription}</p>
                    {entry.evidenceSummary && (
                      <p className="text-muted-foreground leading-tight mt-0.5 text-[11px]">
                        {entry.evidenceSummary.slice(0, 120)}
                        {entry.evidenceSummary.length > 120 ? "…" : ""}
                      </p>
                    )}
                    {entry.state === "unknown" && (
                      <p className="text-muted-foreground text-[11px]">
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
          <div>
            <button
              onClick={() => setShowSignals((v) => !v)}
              className="text-xs text-blue-600 hover:underline"
            >
              {showSignals ? "hide evidence" : `why this candidate (${signals.length} signals)`}
            </button>

            {showSignals && (
              <div className="mt-1 space-y-1 text-xs">
                <p className="text-muted-foreground uppercase tracking-wide text-[10px] font-semibold">
                  Evidence Signals — every signal links to its source
                </p>
                {signals.map((sig) => (
                  <div key={sig.id} className="p-1.5 rounded border bg-muted/30 space-y-0.5">
                    <div className="flex items-center gap-1 flex-wrap">
                      <Badge variant="outline" className="text-[10px]">
                        {sig.signalType.replace("_", " ")}
                      </Badge>
                      <span className="text-muted-foreground">
                        conf: {Math.round(sig.confidence * 100)}%
                      </span>
                      <a
                        href={sig.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline truncate max-w-[200px]"
                      >
                        {sig.sourceUrl}
                      </a>
                    </div>
                    <p className="text-muted-foreground">{sig.extractedFact}</p>
                    <p className="font-mono text-[10px] italic text-muted-foreground">
                      &ldquo;{sig.quotedExcerpt}&rdquo;
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Human-review notice */}
        <div className="text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded p-2">
          <span className="font-semibold">⚠ Human review required: </span>
          {humanReviewNotice}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleShortlist}
            disabled={isLoading || isShortlisted}
            className="flex-1 text-xs rounded border border-blue-300 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950 dark:border-blue-800 px-3 py-1.5 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isShortlisted ? "Shortlisted ✓" : "Shortlist"}
          </button>
          <button
            onClick={handleRerun}
            disabled={isLoading}
            className="text-xs rounded border px-3 py-1.5 hover:bg-muted transition-colors disabled:opacity-50"
            title="Re-run vetting with fresh data"
          >
            {isLoading ? "Running…" : "Re-run"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
