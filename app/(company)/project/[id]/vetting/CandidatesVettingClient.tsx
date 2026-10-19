"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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

  // ── Add Candidate form state ────────────────────────────────────────────────
  const [showAddForm, setShowAddForm]   = useState(false);
  const [addHandle,   setAddHandle]     = useState("");
  const [addName,     setAddName]       = useState("");
  const [addEmail,    setAddEmail]      = useState("");
  const [addStatus,   setAddStatus]     = useState<"idle" | "creating" | "vetting" | "done" | "error">("idle");
  const [addError,    setAddError]      = useState<string | null>(null);
  // Candidates added in this session without a page reload
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
      if (prev.length >= 2) return [prev[1], candidateId]; // replace oldest
      return [...prev, candidateId];
    });
  }

  // ── Add candidate + auto-vet ────────────────────────────────────────────────
  async function handleAddCandidate(e: React.FormEvent) {
    e.preventDefault();
    if (!addHandle.trim()) return;
    setAddStatus("creating");
    setAddError(null);

    // 1. Create the candidate row (consent recorded server-side)
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

    // Optimistically add the candidate to the local list so the card appears immediately
    const displayName  = addName.trim()  || `@${addHandle.trim()}`;
    const displayEmail = addEmail.trim() || `${addHandle.trim()}@github.placeholder`;
    const newCandidate: CandidateRow = {
      id:              candidateId,
      name:            displayName,
      email:           displayEmail,
      githubHandle:    addHandle.trim(),
      portfolioUrl:    null,
      status:          "pending",
      rank:            null,
      trustScore:      null,
      vettingConsentAt: new Date().toISOString(),
      vettingRanAt:    null,
      canDo:           null,
      cannotDo:        null,
    };

    if (!alreadyExists) {
      setFreshCandidates((prev) => [newCandidate, ...prev]);
    }

    toast.loading(`Running vetting for @${addHandle.trim()}…`, { id: "add-candidate" });
    setAddStatus("vetting");

    // 2. Run vetting immediately (consent already granted in step 1)
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

    // Surface LLM/Groq errors even when HTTP 200 (fallback path produces trust=0 silently)
    if (data.usedFallback && data.errors && data.errors.length > 0) {
      toast.error(`LLM unavailable — scores will be 0. Reason: ${data.errors[0]}`, { id: "add-candidate" });
    } else {
      toast.success(`Vetting complete for @${addHandle.trim()}`, { id: "add-candidate" });
    }

    setCandidateData((prev) => ({
      ...prev,
      [candidateId]: {
        trustScore:     data.trustScore as number,
        scoreBreakdown: data.scoreBreakdown as ScoreBreakdown,
        matrix:         data.matrix as MatrixEntry[],
        signals:        (data.matrix as MatrixEntry[]).flatMap((e) => e.signals),
      },
    }));
    setVettingStatus((s) => ({ ...s, [candidateId]: "done" }));
    setAddStatus("done");

    // Reset form
    setAddHandle("");
    setAddName("");
    setAddEmail("");
    setShowAddForm(false);
    setAddStatus("idle");
  }

  async function runVetting(candidateId: string) {
    setVettingStatus((s) => ({ ...s, [candidateId]: "running" }));

    // Give consent first
    await fetch("/api/agent/vetting/consent", {
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
    };

    // Surface LLM/Groq errors even when HTTP 200 (fallback path produces trust=0 silently)
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

  // Merge server-loaded candidates with freshly added ones (fresh first).
  // Deduplicate by id: freshCandidates take precedence; filter out any server
  // candidate whose id already appears in freshCandidates to prevent React key
  // collisions after router.refresh() repopulates the `candidates` prop.
  const freshIds = new Set(freshCandidates.map((c) => c.id));
  const allCandidates = [...freshCandidates, ...candidates.filter((c) => !freshIds.has(c.id))];

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
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => { setShowAddForm((v) => !v); setTimeout(() => handleInputRef.current?.focus(), 50); }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground text-background text-sm font-medium px-3 py-1.5 hover:opacity-90 active:scale-[0.97] transition-all"
          >
            <span className="text-base leading-none">+</span> Add Candidate
          </button>
          <button
            onClick={() => setShowScoringPanel((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showScoringPanel ? "hide scoring" : "how this is scored ↗"}
          </button>
        </div>
      </div>

      {/* Add Candidate inline form */}
      {showAddForm && (
        <form
          onSubmit={(e) => { void handleAddCandidate(e); }}
          className="rounded-lg border bg-muted/30 p-4 space-y-3"
        >
          <h2 className="text-sm font-semibold">Add Candidate</h2>
          <p className="text-xs text-muted-foreground">
            Enter the GitHub handle. The portfolio verifier will fetch public repos and generate the quadrant chart.
            Consent is recorded at the time of submission.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {/* GitHub handle — required */}
            <div className="sm:col-span-1">
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                GitHub handle <span className="text-destructive">*</span>
              </label>
              <div className="flex items-center rounded border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
                <span className="pl-2.5 text-muted-foreground text-sm select-none">@</span>
                <input
                  ref={handleInputRef}
                  type="text"
                  value={addHandle}
                  onChange={(e) => setAddHandle(e.target.value.replace(/^@/, "").replace(/\s/g, ""))}
                  placeholder="username"
                  required
                  maxLength={39}
                  className="flex-1 bg-transparent px-2 py-1.5 text-sm outline-none"
                  disabled={addStatus === "creating" || addStatus === "vetting"}
                />
              </div>
            </div>

            {/* Display name — optional */}
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
                className="w-full rounded border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                disabled={addStatus === "creating" || addStatus === "vetting"}
              />
            </div>

            {/* Email — optional */}
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
                className="w-full rounded border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                disabled={addStatus === "creating" || addStatus === "vetting"}
              />
            </div>
          </div>

          {addError && (
            <p className="text-xs text-destructive">{addError}</p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!addHandle.trim() || addStatus === "creating" || addStatus === "vetting"}
              className="inline-flex items-center gap-2 rounded-lg bg-foreground text-background text-sm font-medium px-4 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 active:scale-[0.97] transition-all"
            >
              {addStatus === "creating" ? (
                <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-background border-t-transparent" /> Creating…</>
              ) : addStatus === "vetting" ? (
                <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-background border-t-transparent" /> Analysing GitHub profile…</>
              ) : (
                "Add & Run Vetting"
              )}
            </button>
            <button
              type="button"
              onClick={() => { setShowAddForm(false); setAddHandle(""); setAddName(""); setAddEmail(""); setAddError(null); setAddStatus("idle"); }}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

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
      {allCandidates.length === 0 ? (
        <div className="text-center py-12 space-y-3">
          <p className="text-muted-foreground">
            {initialQuery
              ? `No candidates match "${initialQuery}".`
              : "No candidates yet."}
          </p>
          {!initialQuery && (
            <button
              onClick={() => { setShowAddForm(true); setTimeout(() => handleInputRef.current?.focus(), 50); }}
              className="inline-flex items-center gap-1.5 rounded-lg border text-sm font-medium px-4 py-2 hover:bg-muted transition-colors"
            >
              <span className="text-base leading-none">+</span> Add your first candidate
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {allCandidates.map((c) => {
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
