"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { VettingCard } from "@/components/vetting/VettingCard";
import { CandidateCompare } from "@/components/vetting/CandidateCompare";
import { buildMatrix, buildScoreBreakdown, type Signal, type MatrixEntry } from "@/lib/vetting/signals";
import type { ScoreBreakdown } from "@/lib/vetting/signals";
import { Badge } from "@/components/ui/badge";

interface CandidateRow {
  id: string;
  name: string;
  email: string;
  githubHandle: string | null;
  portfolioUrl: string | null;
  status: string;
  rank: number | null;
  trustScore: number | null;
  vettingConsentAt: string | null;
  vettingRanAt: string | null;
  canDo: Array<{ skill: string; state: string; evidenceSummary: string | null }> | null;
  cannotDo: Array<{ skill: string }> | null;
}

interface Props {
  projectId: string;
  candidates: CandidateRow[];
  signalsByCandidate: Record<string, Signal[]>;
  requirements: Array<{ id: string; description: string }>;
  humanReviewNotice: string;
  scoringFormula: string;
  initialQuery: string;
}

export function CandidatesVettingClient({
  projectId,
  candidates,
  signalsByCandidate,
  requirements,
  humanReviewNotice,
  scoringFormula,
  initialQuery,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showScoringPanel, setShowScoringPanel] = useState(false);
  const [vettingStatus, setVettingStatus] = useState<Record<string, "idle" | "running" | "done" | "error">>({});
  const [candidateData, setCandidateData] = useState<Record<string, {
    trustScore: number;
    scoreBreakdown: ScoreBreakdown;
    matrix: MatrixEntry[];
    signals: Signal[];
  }>>({});

  function handleSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    router.push(`/project/${projectId}/vetting?${params.toString()}`);
  }

  function toggleCompare(candidateId: string) {
    setCompareIds((prev) => {
      if (prev.includes(candidateId)) return prev.filter((id) => id !== candidateId);
      if (prev.length >= 2) return [prev[1], candidateId]; // replace oldest
      return [...prev, candidateId];
    });
  }

  async function runVetting(candidateId: string) {
    setVettingStatus((s) => ({ ...s, [candidateId]: "running" }));

    // Give consent first
    await fetch("/api/agent/vetting", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, projectId }),
    });

    // Run vetting
    const res = await fetch("/api/agent/vetting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, projectId }),
    });

    if (!res.ok) {
      setVettingStatus((s) => ({ ...s, [candidateId]: "error" }));
      return;
    }

    const data = await res.json();
    setCandidateData((prev) => ({
      ...prev,
      [candidateId]: {
        trustScore: data.trustScore,
        scoreBreakdown: data.scoreBreakdown,
        matrix: data.matrix,
        signals: data.matrix.flatMap((e: MatrixEntry) => e.signals),
      },
    }));
    setVettingStatus((s) => ({ ...s, [candidateId]: "done" }));
  }

  async function handleShortlist(candidateId: string) {
    await fetch("/api/candidates/shortlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, projectId }),
    });
    router.refresh();
  }

  // Build derived data for each candidate
  function getCandidateVettingData(c: CandidateRow) {
    // Prefer fresh data from vetting run; fall back to stored data
    const fresh = candidateData[c.id];
    if (fresh) return fresh;

    const sigs = signalsByCandidate[c.id] ?? [];
    const matrix = buildMatrix(requirements, sigs);
    const scoreBreakdown = buildScoreBreakdown(sigs);

    return {
      trustScore: c.trustScore ?? 0,
      scoreBreakdown,
      matrix,
      signals: sigs,
    };
  }

  // Build compare data
  const compareLeft = compareIds[0] ? candidates.find((c) => c.id === compareIds[0]) : null;
  const compareRight = compareIds[1] ? candidates.find((c) => c.id === compareIds[1]) : null;

  return (
    <div className="px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Candidate Vetting</h1>
          <p className="text-muted-foreground text-sm mt-1">
            AI-assisted vetting from public sources. Your decision always.
          </p>
        </div>
        <button
          onClick={() => setShowScoringPanel((v) => !v)}
          className="text-xs text-blue-600 hover:underline shrink-0"
        >
          {showScoringPanel ? "hide" : "how this is scored ↗"}
        </button>
      </div>

      {/* Scoring transparency panel */}
      {showScoringPanel && (
        <div className="rounded-lg border bg-muted p-4 text-xs space-y-2">
          <h2 className="font-semibold text-sm">Scoring Formula</h2>
          <p className="text-muted-foreground">{scoringFormula}</p>
          <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
            <li>Sources: GitHub repos/PRs, portfolio URLs, public review pages</li>
            <li>LinkedIn is displayed as a link only — never fetched or scraped</li>
            <li>Personal attributes (name, photo, gender, age, nationality, location) are never used as scoring features</li>
            <li>LLM extracts facts; all excerpts are verified to exist in fetched content</li>
            <li>&ldquo;Unknown&rdquo; means no evidence found — it is never inferred</li>
            <li>The company always makes the final decision</li>
          </ul>
        </div>
      )}

      {/* Human-review notice — always visible */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950 p-3 text-xs">
        <span className="font-semibold">⚠ Human review required: </span>
        {humanReviewNotice}
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search candidates by name, handle, or skill…"
          className="flex-1 text-sm rounded border px-3 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="submit"
          className="text-sm rounded border px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Search
        </button>
        {initialQuery && (
          <button
            type="button"
            onClick={() => { setQuery(""); router.push(`/project/${projectId}/vetting`); }}
            className="text-sm rounded border px-3 py-2 hover:bg-muted transition-colors"
          >
            Clear
          </button>
        )}
      </form>

      {/* Compare instructions */}
      {compareIds.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Comparing {compareIds.length}/2 candidates.</span>
          {compareIds.length < 2 && <span>Select one more to compare.</span>}
          <button
            onClick={() => setCompareIds([])}
            className="text-blue-600 hover:underline"
          >
            clear
          </button>
        </div>
      )}

      {/* Side-by-side compare */}
      {compareLeft && compareRight && (() => {
        const leftData = getCandidateVettingData(compareLeft);
        const rightData = getCandidateVettingData(compareRight);
        return (
          <CandidateCompare
            left={{ id: compareLeft.id, name: compareLeft.name, ...leftData }}
            right={{ id: compareRight.id, name: compareRight.name, ...rightData }}
            onClose={() => setCompareIds([])}
          />
        );
      })()}

      {/* Candidate grid */}
      {candidates.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {initialQuery
            ? `No candidates match "${initialQuery}".`
            : "No candidates yet. Add candidates to start vetting."}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {candidates.map((c) => {
            const vettingData = getCandidateVettingData(c);
            const status = vettingStatus[c.id] ?? "idle";
            const hasVetting = (c.vettingRanAt != null) || (candidateData[c.id] != null);

            return (
              <div key={c.id} className="relative">
                {/* Compare checkbox */}
                <label className="absolute top-2 right-2 z-10 flex items-center gap-1 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={compareIds.includes(c.id)}
                    onChange={() => toggleCompare(c.id)}
                    className="rounded"
                  />
                  <span className="text-muted-foreground">compare</span>
                </label>

                {!hasVetting ? (
                  /* Consent + run vetting gate */
                  <div className="rounded-lg border p-4 space-y-3 text-xs">
                    <div className="font-medium">{c.name}</div>
                    <p className="text-muted-foreground text-[11px]">{c.email}</p>
                    {c.githubHandle && (
                      <p className="text-muted-foreground">@{c.githubHandle}</p>
                    )}
                    <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-muted-foreground">
                      <p className="font-semibold">Consent required</p>
                      <p>This candidate must give in-app consent before vetting begins.</p>
                    </div>
                    <button
                      onClick={() => runVetting(c.id)}
                      disabled={status === "running"}
                      className="w-full rounded border border-blue-300 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 font-medium transition-colors disabled:opacity-50"
                    >
                      {status === "running" ? "Running vetting…" :
                       status === "error" ? "Error — retry" :
                       "Record Consent + Run Vetting"}
                    </button>
                    {status === "error" && (
                      <p className="text-red-600 text-[10px]">Vetting failed. Check logs.</p>
                    )}
                  </div>
                ) : (
                  <VettingCard
                    candidate={c}
                    trustScore={vettingData.trustScore}
                    scoreBreakdown={vettingData.scoreBreakdown}
                    matrix={vettingData.matrix}
                    signals={vettingData.signals}
                    humanReviewNotice={humanReviewNotice}
                    scoringFormula={scoringFormula}
                    isShortlisted={c.status === "shortlisted"}
                    projectId={projectId}
                    onShortlist={handleShortlist}
                    onRerunVetting={() => runVetting(c.id)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
