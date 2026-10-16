"use client";

/**
 * CandidateComplianceBar — compact inline panel shown on the milestones page.
 *
 * Fetches candidates for a project and displays:
 * - Candidate name + GitHub handle (verification link)
 * - Trust score ring (color-coded: green ≥70, amber ≥40, red <40)
 * - Top 3 can-do skills
 * - Link to full vetting dashboard
 *
 * This component is lazy-loaded so it doesn't block the milestone render.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

// ── Types ──────────────────────────────────────────────────────────────────

interface CanDoEntry {
  skill: string;
  state: string;
  evidenceSummary: string | null;
}

interface CompactCandidate {
  id: string;
  name: string;
  email: string;
  githubHandle: string | null;
  status: string;
  rank: number | null;
  trustScore: number | null;
  vettingConsentAt: string | null;
  vettingRanAt: string | null;
  canDo: CanDoEntry[] | null;
}

interface Props {
  projectId: string;
}

// ── Trust score helpers ────────────────────────────────────────────────────

function scoreLabel(score: number): string {
  if (score >= 0.7) return "High";
  if (score >= 0.4) return "Medium";
  return "Low";
}

function scoreBg(score: number): string {
  if (score >= 0.7) return "bg-emerald-500";
  if (score >= 0.4) return "bg-amber-400";
  return "bg-red-400";
}

function scoreText(score: number): string {
  if (score >= 0.7) return "text-emerald-700";
  if (score >= 0.4) return "text-amber-700";
  return "text-red-600";
}

// ── Component ──────────────────────────────────────────────────────────────

export function CandidateComplianceBar({ projectId }: Props) {
  const [candidates, setCandidates] = useState<CompactCandidate[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/candidates/search?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: { results: CompactCandidate[] }) => {
        if (!cancelled) setCandidates(data.results ?? []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  if (error || candidates === null) return null;
  if (candidates.length === 0) return null;

  const vettedCandidates = candidates.filter((c) => c.vettingRanAt !== null);
  const shortlisted = candidates.filter(
    (c) => c.status === "shortlisted" || c.status === "accepted"
  );

  return (
    <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Candidate Compliance</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {vettedCandidates.length}/{candidates.length} vetted
            {shortlisted.length > 0 && ` · ${shortlisted.length} shortlisted`}
          </p>
        </div>
        <Link
          href={`/project/${projectId}/vetting`}
          className="text-xs text-primary underline underline-offset-2 hover:no-underline"
        >
          Full vetting report →
        </Link>
      </div>

      {/* Candidate rows */}
      <div className="space-y-2">
        {candidates.slice(0, 5).map((c) => (
          <CandidateRow key={c.id} candidate={c} projectId={projectId} />
        ))}
        {candidates.length > 5 && (
          <p className="text-xs text-muted-foreground">
            +{candidates.length - 5} more —{" "}
            <Link href={`/project/${projectId}/vetting`} className="underline">
              view all
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

// ── Single candidate row ───────────────────────────────────────────────────

function CandidateRow({
  candidate,
  projectId,
}: {
  candidate: CompactCandidate;
  projectId: string;
}) {
  const score = candidate.trustScore;
  const vetted = !!candidate.vettingRanAt;
  const topSkills = (candidate.canDo ?? [])
    .filter((s) => s.state === "can")
    .slice(0, 3);

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm">
      {/* Score ring */}
      <div className="flex-shrink-0 flex flex-col items-center w-10">
        {score !== null && vetted ? (
          <>
            <div className={`relative w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 ${scoreBg(score)} border-transparent text-white`}>
              {Math.round(score * 100)}
            </div>
            <span className={`text-[10px] font-medium mt-0.5 ${scoreText(score)}`}>
              {scoreLabel(score)}
            </span>
          </>
        ) : (
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-muted border border-border text-muted-foreground text-[10px]">
            {vetted ? "—" : "N/A"}
          </div>
        )}
      </div>

      {/* Name + GitHub */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium truncate">{candidate.name}</span>
          {candidate.githubHandle && (
            <a
              href={`https://github.com/${candidate.githubHandle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
              title="Verified GitHub profile"
            >
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 fill-current" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              @{candidate.githubHandle}
            </a>
          )}
          <CandidateStatusBadge status={candidate.status} />
        </div>

        {/* Top skills */}
        {topSkills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {topSkills.map((s, i) => (
              <span
                key={i}
                className="inline-flex text-[10px] px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800"
              >
                {s.skill}
              </span>
            ))}
          </div>
        )}

        {!vetted && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Not yet vetted —{" "}
            <a href={`/project/${projectId}/vetting`} className="underline">
              run vetting
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function CandidateStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
    pending:      { label: "Pending",     variant: "outline" },
    screening:    { label: "Screening",   variant: "secondary" },
    shortlisted:  { label: "Shortlisted", variant: "default" },
    accepted:     { label: "Accepted",    variant: "default" },
    rejected:     { label: "Rejected",    variant: "destructive" },
    withdrawn:    { label: "Withdrawn",   variant: "secondary" },
  };
  const cfg = map[status] ?? { label: status, variant: "outline" };
  return <Badge variant={cfg.variant} className="text-[10px] h-4 px-1.5">{cfg.label}</Badge>;
}
