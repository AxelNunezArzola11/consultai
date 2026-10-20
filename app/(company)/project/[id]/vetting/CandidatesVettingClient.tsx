"use client";

import { useState, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { VettingCard } from "@/components/vetting/VettingCard";
import { CandidateCompare } from "@/components/vetting/CandidateCompare";
import { QuadrantChart } from "@/components/vetting/QuadrantChart";
import { buildMatrix, buildScoreBreakdown, type Signal, type MatrixEntry } from "@/lib/vetting/signals";
import type { ScoreBreakdown } from "@/lib/vetting/signals";

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

// ── View modes ──────────────────────────────────────────────────────────────
type ViewMode = "grid" | "quadrant";

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
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showScoringPanel, setShowScoringPanel] = useState(false);
  const [vettingStatus, setVettingStatus] = useState<Record<string, "idle" | "running" | "done" | "error">>({});
  const [candidateData, setCandidateData] = useState<Record<string, {
    trustScore: number;
    scoreBreakdown: ScoreBreakdown;
    matrix: MatrixEntry[];
    signals: Signal[];
    debugPayload?: unknown;
  }>>({});

  // ── Add Candidate form state ──────────────────────────────────────────────
  const [showAddForm, setShowAddForm]   = useState(false);
  const [addHandle,   setAddHandle]     = useState("");
  const [addName,     setAddName]       = useState("");
  const [addEmail,    setAddEmail]      = useState("");
  const [addStatus,   setAddStatus]     = useState<"idle" | "creating" | "vetting" | "done" | "error">("idle");
  const [addError,    setAddError]      = useState<string | null>(null);
  const [freshCandidates, setFreshCandidates] = useState<CandidateRow[]>([]);
  const handleInputRef = useRef<HTMLInputElement>(null);

  function handleSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    router.push(`/project/${projectId}/vetting?${params.toString()}`);
  }

  function toggleCompare(candidateId: string) {
    setCompareIds((prev) => {
      if (prev.includes(candidateId)) return prev.filter((id) => id !== candidateId);
      if (prev.length >= 2) return [prev[1], candidateId];
      return [...prev, candidateId];
    });
  }

  async function handleAddCandidate(e: React.FormEvent) {
    e.preventDefault();
    if (!addHandle.trim()) return;
    setAddStatus("creating");
    setAddError(null);

    const createRes = await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        githubHandle: addHandle.trim(),
        name:  addName.trim()  || undefined,
        email: addEmail.trim() || undefined,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({})) as Record<string, unknown>;
      setAddStatus("error");
      setAddError(String(err.error ?? "Failed to create candidate"));
      return;
    }

    const { id: candidateId, alreadyExists } = await createRes.json() as { id: string; alreadyExists: boolean };

    const displayName  = addName.trim()  || `@${addHandle.trim()}`;
    const displayEmail = addEmail.trim() || `${addHandle.trim()}@github.placeholder`;
    const newCandidate: CandidateRow = {
      id: candidateId, name: displayName, email: displayEmail,
      githubHandle: addHandle.trim(), portfolioUrl: null,
      status: "pending", rank: null, trustScore: null,
      vettingConsentAt: new Date().toISOString(), vettingRanAt: null,
      canDo: null, cannotDo: null,
    };

    if (!alreadyExists) {
      setFreshCandidates((prev) => [newCandidate, ...prev]);
    }

    toast.loading(`Running vetting for @${addHandle.trim()}…`, { id: "add-candidate" });
    setAddStatus("vetting");

    const vetRes = await fetch("/api/agent/vetting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, projectId }),
    });

    if (!vetRes.ok) {
      const err = await vetRes.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = String(err.error ?? `HTTP ${vetRes.status} ${vetRes.statusText}`);
      setVettingStatus((s) => ({ ...s, [candidateId]: "error" }));
      setAddStatus("error");
      setAddError(errMsg);
      toast.error(`Vetting failed: ${errMsg}`, { id: "add-candidate" });
      return;
    }

    const data = await vetRes.json() as {
      trustScore: number;
      scoreBreakdown: ScoreBreakdown;
      matrix: MatrixEntry[];
      usedFallback?: boolean;
      errors?: string[];
    };

    if (data.usedFallback && data.errors && data.errors.length > 0) {
      toast.error(`LLM unavailable — scores will be 0. Reason: ${data.errors[0]}`, { id: "add-candidate" });
    } else {
      toast.success(`Vetting complete for @${addHandle.trim()}`, { id: "add-candidate" });
    }

    setCandidateData((prev) => ({
      ...prev,
      [candidateId]: {
        trustScore: data.trustScore as number,
        scoreBreakdown: data.scoreBreakdown as ScoreBreakdown,
        matrix: data.matrix as MatrixEntry[],
        signals: (data.matrix as MatrixEntry[]).flatMap((e) => e.signals),
      },
    }));
    setVettingStatus((s) => ({ ...s, [candidateId]: "done" }));
    setAddStatus("done");
    setAddHandle(""); setAddName(""); setAddEmail("");
    setShowAddForm(false); setAddStatus("idle");
  }

  async function runVetting(candidateId: string) {
    setVettingStatus((s) => ({ ...s, [candidateId]: "running" }));

    await fetch("/api/agent/vetting/consent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, projectId }),
    });

    const res = await fetch("/api/agent/vetting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, projectId }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = String(errBody.error ?? `HTTP ${res.status} ${res.statusText}`);
      setVettingStatus((s) => ({ ...s, [candidateId]: "error" }));
      toast.error(`Vetting failed: ${errMsg}`);
      return;
    }

    const data = await res.json() as {
      trustScore: number;
      scoreBreakdown: ScoreBreakdown;
      matrix: MatrixEntry[];
      usedFallback?: boolean;
      errors?: string[];
      debugPayload?: unknown;
    };

    if (data.usedFallback && data.errors && data.errors.length > 0) {
      toast.error(`LLM unavailable — scores will be 0. Reason: ${data.errors[0]}`);
    }

    setCandidateData((prev) => ({
      ...prev,
      [candidateId]: {
        trustScore: data.trustScore,
        scoreBreakdown: data.scoreBreakdown,
        matrix: data.matrix,
        signals: data.matrix.flatMap((e: MatrixEntry) => e.signals),
        debugPayload: data.debugPayload,
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

  function getCandidateVettingData(c: CandidateRow) {
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
      debugPayload: undefined as unknown,
    };
  }

  // Merged candidate list
  const freshIds = new Set(freshCandidates.map((c) => c.id));
  const allCandidates = [...freshCandidates, ...candidates.filter((c) => !freshIds.has(c.id))];

  // Compare data
  const compareLeft  = compareIds[0] ? allCandidates.find((c) => c.id === compareIds[0]) : null;
  const compareRight = compareIds[1] ? allCandidates.find((c) => c.id === compareIds[1]) : null;

  // Quadrant chart data — only vetted candidates
  const quadrantPoints = useMemo(
    () =>
      allCandidates
        .filter((c) => c.vettingRanAt != null || candidateData[c.id] != null)
        .map((c) => {
          const vd = getCandidateVettingData(c);
          const stackMatch = vd.scoreBreakdown?.bySignalType?.github_repo?.avgConfidence ?? 0;
          return {
            id: c.id,
            name: c.githubHandle ?? c.name,
            trustScore: vd.trustScore,
            stackMatch,
            isShortlisted: c.status === "shortlisted",
          };
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCandidates, candidateData]
  );

  const vettedCount = allCandidates.filter((c) => c.vettingRanAt != null || candidateData[c.id] != null).length;

  return (
    <div className="px-6 py-6 space-y-5">
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Candidate Vetting</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            AI-assisted vetting from public sources. Your decision always.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {/* View mode toggle */}
          <div className="flex items-center gap-0.5 bg-muted/60 border border-border rounded-lg p-0.5">
            {(["grid", "quadrant"] as ViewMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setViewMode(m)}
                className={[
                  "text-xs font-medium px-3 py-1.5 rounded-md transition-all",
                  viewMode === m
                    ? "bg-card text-foreground shadow-sm border border-border"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {m === "grid" ? "⊞ Cards" : "◎ Quadrant"}
              </button>
            ))}
          </div>

          {/* Add candidate */}
          <button
            type="button"
            onClick={() => { setShowAddForm((v) => !v); setTimeout(() => handleInputRef.current?.focus(), 50); }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold px-3 py-2 hover:bg-primary/90 active:scale-[0.97] transition-all shadow-sm shadow-primary/20"
          >
            <span className="text-sm leading-none">+</span> Add Candidate
          </button>

          {/* Scoring formula toggle */}
          <button
            type="button"
            onClick={() => setShowScoringPanel((v) => !v)}
            className={[
              "text-xs font-medium px-2.5 py-2 rounded-lg border transition-all",
              showScoringPanel
                ? "bg-muted/60 text-foreground border-border"
                : "text-muted-foreground hover:text-foreground border-transparent hover:border-border hover:bg-muted/40",
            ].join(" ")}
          >
            {showScoringPanel ? "hide scoring" : "how scored ↗"}
          </button>
        </div>
      </div>

      {/* ── Add Candidate form ────────────────────────────────────────────── */}
      {showAddForm && (
        <form
          onSubmit={(e) => { void handleAddCandidate(e); }}
          className="rounded-xl border border-border bg-card/80 p-4 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Add Candidate</h2>
            <button
              type="button"
              onClick={() => { setShowAddForm(false); setAddHandle(""); setAddName(""); setAddEmail(""); setAddError(null); setAddStatus("idle"); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ✕ Cancel
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Enter a GitHub handle. The portfolio verifier fetches public repos and generates a quadrant score.
            Consent is recorded at submission.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                GitHub handle <span className="text-destructive">*</span>
              </label>
              <div className="flex items-center rounded-lg border border-border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
                <span className="pl-2.5 text-muted-foreground text-sm select-none">@</span>
                <input
                  ref={handleInputRef}
                  type="text"
                  value={addHandle}
                  onChange={(e) => setAddHandle(e.target.value.replace(/^@/, "").replace(/\s/g, ""))}
                  placeholder="username"
                  required
                  maxLength={39}
                  className="flex-1 bg-transparent px-2 py-2 text-sm outline-none"
                  disabled={addStatus === "creating" || addStatus === "vetting"}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Display name <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder={addHandle ? `@${addHandle}` : "Full name"}
                maxLength={200}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                disabled={addStatus === "creating" || addStatus === "vetting"}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Email <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <input
                type="email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder="candidate@example.com"
                maxLength={254}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                disabled={addStatus === "creating" || addStatus === "vetting"}
              />
            </div>
          </div>

          {addError && (
            <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              {addError}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!addHandle.trim() || addStatus === "creating" || addStatus === "vetting"}
              className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 active:scale-[0.97] transition-all shadow-sm shadow-primary/20"
            >
              {addStatus === "creating" ? (
                <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> Creating…</>
              ) : addStatus === "vetting" ? (
                <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> Analysing GitHub profile…</>
              ) : (
                "Add & Run Vetting"
              )}
            </button>
          </div>
        </form>
      )}

      {/* ── Scoring transparency panel ─────────────────────────────────── */}
      {showScoringPanel && (
        <div className="rounded-xl border border-border bg-card/80 p-4 text-xs space-y-2">
          <h2 className="font-semibold text-sm text-foreground">Scoring Formula</h2>
          <p className="text-muted-foreground">{scoringFormula}</p>
          <ul className="space-y-0.5 text-muted-foreground mt-2">
            {[
              "Sources: GitHub repos/PRs, portfolio URLs, public review pages",
              "LinkedIn is displayed as a link only — never fetched or scraped",
              "Personal attributes (name, photo, gender, age, nationality, location) are never used as scoring features",
              "LLM extracts facts; all excerpts are verified to exist in fetched content",
              '"Unknown" means no evidence found — it is never inferred',
              "The company always makes the final decision",
            ].map((point, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-primary mt-0.5">·</span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Human-review notice — always visible ───────────────────────── */}
      <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-3 text-xs text-amber-300/80">
        <span className="font-semibold text-amber-300">⚠ Human review required: </span>
        {humanReviewNotice}
      </div>

      {/* ── Quadrant chart (when in quadrant mode or enough vetted candidates) ── */}
      {(viewMode === "quadrant" || (quadrantPoints.length >= 2)) && (
        <div className={viewMode === "quadrant" ? "block" : "hidden"}>
          <QuadrantChart points={quadrantPoints} onClickPoint={undefined} />
        </div>
      )}
      {viewMode === "quadrant" && quadrantPoints.length === 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-8 text-center">
          <p className="text-muted-foreground text-sm">
            Run vetting on at least one candidate to see the quadrant chart.
          </p>
        </div>
      )}

      {/* ── Search ─────────────────────────────────────────────────────── */}
      {viewMode === "grid" && (
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="flex-1 flex items-center rounded-lg border border-border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
            <span className="pl-3 text-muted-foreground text-sm select-none">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search candidates by name, handle, or skill…"
              className="flex-1 text-sm px-3 py-2 bg-transparent focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="text-xs rounded-lg border border-border px-4 py-2 bg-muted/50 text-foreground hover:bg-muted transition-colors font-medium"
          >
            Search
          </button>
          {initialQuery && (
            <button
              type="button"
              onClick={() => { setQuery(""); router.push(`/project/${projectId}/vetting`); }}
              className="text-xs rounded-lg border border-border px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              Clear
            </button>
          )}
        </form>
      )}

      {/* ── Stats strip ─────────────────────────────────────────────────── */}
      {allCandidates.length > 0 && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            <strong className="text-foreground tabular-nums">{allCandidates.length}</strong> candidates
          </span>
          <span>
            <strong className="text-emerald-400 tabular-nums">{vettedCount}</strong> vetted
          </span>
          <span>
            <strong className="text-primary tabular-nums">
              {allCandidates.filter((c) => c.status === "shortlisted").length}
            </strong> shortlisted
          </span>
          {compareIds.length > 0 && (
            <span className="flex items-center gap-1.5 ml-auto">
              Comparing {compareIds.length}/2
              {compareIds.length < 2 && <span className="text-muted-foreground/60">· select one more</span>}
              <button
                type="button"
                onClick={() => setCompareIds([])}
                className="text-xs text-primary hover:text-primary/80 transition-colors ml-1"
              >
                clear
              </button>
            </span>
          )}
        </div>
      )}

      {/* ── Side-by-side compare ─────────────────────────────────────────── */}
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

      {/* ── Candidate grid (cards view) ────────────────────────────────── */}
      {viewMode === "grid" && (
        allCandidates.length === 0 ? (
          <div className="text-center py-16 space-y-4">
            <div className="text-5xl opacity-20">◎</div>
            <p className="text-muted-foreground">
              {initialQuery
                ? `No candidates match "${initialQuery}".`
                : "No candidates yet."}
            </p>
            {!initialQuery && (
              <button
                type="button"
                onClick={() => { setShowAddForm(true); setTimeout(() => handleInputRef.current?.focus(), 50); }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border text-xs font-medium px-4 py-2 hover:bg-muted/60 transition-colors"
              >
                <span className="text-base leading-none">+</span> Add your first candidate
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {allCandidates.map((c) => {
              const vettingData = getCandidateVettingData(c);
              const status = vettingStatus[c.id] ?? "idle";
              const hasVetting = (c.vettingRanAt != null) || (candidateData[c.id] != null);

              return (
                <div key={c.id} className="relative">
                  {/* Compare checkbox */}
                  <label className="absolute top-3 right-3 z-20 flex items-center gap-1 text-[11px] cursor-pointer select-none group/compare">
                    <input
                      type="checkbox"
                      checked={compareIds.includes(c.id)}
                      onChange={() => toggleCompare(c.id)}
                      className="rounded accent-primary"
                    />
                    <span className="text-muted-foreground group-hover/compare:text-foreground transition-colors">
                      compare
                    </span>
                  </label>

                  {!hasVetting ? (
                    /* Consent + run vetting gate */
                    <div className="rounded-xl border border-border bg-card p-4 space-y-3 text-xs shadow-md">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-foreground text-sm">{c.name}</p>
                          <p className="text-muted-foreground text-[11px] mt-0.5">{c.email}</p>
                          {c.githubHandle && (
                            <p className="text-muted-foreground/70 text-[11px]">@{c.githubHandle}</p>
                          )}
                        </div>
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground border border-border">
                          Unvetted
                        </span>
                      </div>
                      <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-2.5 text-[11px] text-amber-300/80">
                        <p className="font-semibold text-amber-300">Consent required</p>
                        <p>This candidate must give in-app consent before vetting begins.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => runVetting(c.id)}
                        disabled={status === "running"}
                        className="w-full rounded-lg bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 px-3 py-2 font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed text-xs"
                      >
                        {status === "running" ? (
                          <span className="flex items-center justify-center gap-1.5">
                            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            Running vetting…
                          </span>
                        ) : status === "error" ? "⚠ Error — retry" : "Record Consent + Run Vetting"}
                      </button>
                      {status === "error" && (
                        <p className="text-destructive text-[10px]">Vetting failed. Check logs.</p>
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
                      debugPayload={vettingData.debugPayload}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ── Quadrant mode: inline view below chart ─────────────────────── */}
      {viewMode === "quadrant" && quadrantPoints.length > 0 && (
        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {quadrantPoints.map((pt) => {
            const c = allCandidates.find((x) => x.id === pt.id);
            if (!c) return null;
            const vd = getCandidateVettingData(c);
            const pct = Math.round(pt.trustScore * 100);
            const stackPct = Math.round(pt.stackMatch * 100);
            return (
              <div key={pt.id} className="flex items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-2.5">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  pct >= 75 ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800"
                    : pct >= 40 ? "bg-amber-950/80 text-amber-400 border border-amber-800"
                    : "bg-slate-800 text-slate-400 border border-slate-700"
                }`}>{pct}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-foreground truncate">{pt.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-muted-foreground">trust {pct}%</span>
                    <span className="text-[10px] text-muted-foreground/50">·</span>
                    <span className="text-[10px] text-muted-foreground">stack {stackPct}%</span>
                    <span className="text-[10px] text-muted-foreground/50">·</span>
                    <span className="text-[10px] text-muted-foreground">
                      {vd.matrix.filter((m) => m.state === "can").length}✓
                      {" / "}
                      {vd.matrix.filter((m) => m.state === "no").length}✗
                    </span>
                  </div>
                </div>
                {pt.isShortlisted && (
                  <span className="text-[10px] text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded-full shrink-0">
                    ✓
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
