/**
 * Candidate pipeline dashboard — Phase 4
 *
 * Displays candidates in columns by status, deadline timers,
 * last agent event, and activity feed.
 */

export const dynamic = "force-dynamic";

import { eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/lib/db";
import { candidates, ndas, meetings, cascadeLog } from "@/lib/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { lazyExpireNdas, lazyCheckNoShows } from "@/lib/scheduling/lazy-checks";
import { NdaGenerateButton } from "@/components/candidates/NdaGenerateButton";
import { HireConsultantButton } from "@/components/candidates/HireConsultantButton";
import { CandidateDemoControls } from "@/components/candidates/CandidateDemoControls";
import { PipelinePoller } from "@/components/candidates/PipelinePoller";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { requireProjectAccess } from "@/lib/auth/guards";

// ---------------------------------------------------------------------------
// Pipeline column config
// ---------------------------------------------------------------------------

const PIPELINE_COLUMNS = [
  { key: "found",            label: "Found",            badgeClass: "border-slate-700 bg-slate-800/80 text-slate-300",   dot: "bg-slate-400" },
  { key: "shortlisted",      label: "Shortlisted",      badgeClass: "border-blue-500/30 bg-blue-500/15 text-blue-300",   dot: "bg-blue-400" },
  { key: "pending",          label: "Pending",          badgeClass: "border-slate-700 bg-slate-800/80 text-slate-300",   dot: "bg-slate-400" },
  { key: "nda_sent",         label: "NDA Sent",         badgeClass: "border-amber-500/30 bg-amber-500/15 text-amber-300", dot: "bg-amber-400" },
  { key: "nda_signed",       label: "NDA Signed",       badgeClass: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300", dot: "bg-emerald-400" },
  { key: "booking_unlocked", label: "Booking Unlocked", badgeClass: "border-teal-500/30 bg-teal-500/15 text-teal-300",   dot: "bg-teal-400" },
  { key: "booked",           label: "Booked",           badgeClass: "border-cyan-500/30 bg-cyan-500/15 text-cyan-300",   dot: "bg-cyan-400" },
  { key: "scheduled",        label: "Scheduled",        badgeClass: "border-cyan-500/30 bg-cyan-500/15 text-cyan-300",   dot: "bg-cyan-400" },
  { key: "meeting_held",     label: "Meeting Held",     badgeClass: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300", dot: "bg-emerald-400" },
  { key: "selected",         label: "Selected",         badgeClass: "border-emerald-500/40 bg-emerald-500/20 text-emerald-200", dot: "bg-emerald-400" },
] as const;

const TERMINAL_COLUMNS = [
  { key: "declined",        label: "Declined" },
  { key: "expired",         label: "Expired" },
  { key: "cancelled",       label: "Cancelled" },
  { key: "no_show",         label: "No Show" },
  { key: "invalid_booking", label: "Invalid Booking" },
  { key: "rejected",        label: "Rejected" },
  { key: "cascaded",        label: "Cascaded" },
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface Props {
  params: Promise<{ id: string }>;
}

export default async function CandidatePipelinePage({ params }: Props) {
  const { id: projectId } = await params;
  // Role gate + company ownership (live); cross-company -> notFound, before any query/mutation.
  await requireProjectAccess(projectId);
  const demoTables = isDemoMode() ? getDemoTables() : null;

  // Lazy expiry checks on every page load (live database only)
  if (!demoTables) {
    await Promise.allSettled([
      lazyExpireNdas(projectId),
      lazyCheckNoShows(projectId),
    ]);
  }

  const allCandidates = demoTables
    ? demoTables.candidates
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    : await db
        .select()
        .from(candidates)
        .where(eq(candidates.projectId, projectId))
        .orderBy(candidates.rank);

  // Fetch NDAs for expiry display
  const candidateIds = allCandidates.map((c) => c.id);
  const ndaList = demoTables
    ? demoTables.ndas.filter((n) => candidateIds.includes(n.candidateId))
    : candidateIds.length > 0
      ? await db
          .select()
          .from(ndas)
          .where(inArray(ndas.candidateId, candidateIds))
      : [];

  const ndaByCandidate = Object.fromEntries(
    ndaList.map((n) => [n.candidateId, n])
  );

  // Fetch meetings
  const meetingList = demoTables
    ? demoTables.meetings.filter((m) => candidateIds.includes(m.candidateId))
    : candidateIds.length > 0
      ? await db
          .select()
          .from(meetings)
          .where(inArray(meetings.candidateId, candidateIds))
      : [];

  const meetingByCandidate = Object.fromEntries(
    meetingList.map((m) => [m.candidateId, m])
  );

  // Group candidates by status
  const byStatus = new Map<string, typeof allCandidates>();
  for (const c of allCandidates) {
    const key = c.status;
    if (!byStatus.has(key)) byStatus.set(key, []);
    byStatus.get(key)!.push(c);
  }

  const { areDemoWriteControlsEnabled } = await import("@/lib/demo/config");
  const showDemoControls = areDemoWriteControlsEnabled();

  // Count cascade rounds
  const cascadeLogs = demoTables
    ? demoTables.cascadeLog.filter((l) => l.projectId === projectId)
    : await db
        .select()
        .from(cascadeLog)
        .where(eq(cascadeLog.projectId, projectId));

  const activeStageCount = PIPELINE_COLUMNS.filter(
    (col) => (byStatus.get(col.key)?.length ?? 0) > 0
  ).length;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 py-7 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Candidate Pipeline &amp; NDA Execution</h1>
          <p className="text-slate-300 text-xs mt-1">
            Live stage progression from talent discovery to cryptographic NDA acceptance and meeting booking.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {cascadeLogs.length > 0 && (
            <Badge variant="secondary" className="text-xs tabular-nums">
              {cascadeLogs.length} cascade{cascadeLogs.length !== 1 ? "s" : ""}
            </Badge>
          )}
          <Link
            href={`/project/${projectId}/vetting`}
            className="rounded-lg border border-blue-500/35 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-500/20"
          >
            ◎ Candidate Vetting →
          </Link>
          <Link
            href={`/project/${projectId}/milestones`}
            className="rounded-lg border border-slate-700/80 bg-[#0f141e] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
          >
            ◈ Milestones
          </Link>
        </div>
      </div>

      {/* Pipeline Summary Strip */}
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-800 bg-slate-800 gap-px sm:grid-cols-4">
        <div className="bg-[#0f141e] p-3.5">
          <div className="text-xs font-medium text-slate-300">Total Candidates</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-white">
            {allCandidates.length}
          </div>
        </div>
        <div className="bg-[#0f141e] p-3.5">
          <div className="text-xs font-medium text-slate-300">Active Pipeline Stages</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-blue-400">
            {activeStageCount}
          </div>
        </div>
        <div className="bg-[#0f141e] p-3.5">
          <div className="text-xs font-medium text-slate-300">NDAs Issued / Signed</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-emerald-400">
            {ndaList.filter((n) => n.status === "accepted").length} / {ndaList.length}
          </div>
        </div>
        <div className="bg-[#0f141e] p-3.5">
          <div className="text-xs font-medium text-slate-300">Scheduled Meetings</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-cyan-400">
            {meetingList.length}
          </div>
        </div>
      </div>

      {/* Active pipeline board */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">
            Active Pipeline Board
          </h2>
          <span className="text-xs text-slate-400">
            Issue single-use SHA-256 NDA links to shortlisted consultants
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PIPELINE_COLUMNS.map((col) => {
            const group = byStatus.get(col.key) ?? [];
            if (group.length === 0) return null;
            return (
              <div
                key={col.key}
                className="pipeline-column-contain rounded-xl border border-slate-800 bg-[#0f141e] p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                  <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold ${col.badgeClass}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${col.dot}`} />
                    {col.label}
                  </span>
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-slate-200">
                    {group.length}
                  </span>
                </div>
                <div className="space-y-2.5">
                  {group.map((c) => (
                    <CandidateCard
                      key={c.id}
                      candidate={c}
                      nda={ndaByCandidate[c.id]}
                      meeting={meetingByCandidate[c.id]}
                      isDemoMode={showDemoControls}
                      projectId={projectId}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Terminal states */}
      {TERMINAL_COLUMNS.some((col) => (byStatus.get(col.key)?.length ?? 0) > 0) && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-300">
            Archived / Terminal States
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            {TERMINAL_COLUMNS.map((col) => {
              const group = byStatus.get(col.key) ?? [];
              if (group.length === 0) return null;
              return (
                <div key={col.key} className="rounded-xl border border-slate-800 bg-[#0f141e] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-semibold text-slate-300">
                      {col.label}
                    </span>
                    <Badge variant="outline" className="text-xs tabular-nums">
                      {group.length}
                    </Badge>
                  </div>
                  <div className="space-y-2">
                    {group.map((c) => (
                      <div
                        key={c.id}
                        className="text-xs rounded-lg border border-slate-800 bg-[#0b0f17] px-3 py-2"
                      >
                        <p className="font-medium text-slate-200 truncate">{c.name}</p>
                        {c.rejectionReason && (
                          <p className="text-slate-400 truncate mt-0.5">
                            {c.rejectionReason}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {allCandidates.length === 0 && (
        <Card className="border-slate-800 bg-[#0f141e]">
          <CardContent className="py-12 text-center text-slate-300">
            No candidates yet. Run the Vetting Agent to populate this pipeline.
          </CardContent>
        </Card>
      )}

      {/* Cascade activity log */}
      {cascadeLogs.length > 0 && (
        <div className="space-y-2.5">
          <h2 className="text-sm font-semibold text-slate-200">
            Cascade Activity Log
          </h2>
          <div className="space-y-2">
            {cascadeLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between text-xs border border-slate-800 rounded-lg px-3.5 py-2.5 bg-[#0f141e]"
              >
                <span className="text-slate-200">
                  Round {log.round} — <strong className="text-white">{log.reason}</strong>
                </span>
                <span className="font-mono text-slate-400 tabular-nums">
                  {new Date(log.createdAt).toLocaleString("en-US", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Demo controls */}
      {showDemoControls && (
        <CandidateDemoControls
          projectId={projectId}
          ndaSentCandidates={allCandidates
            .filter((c) => c.status === "nda_sent")
            .map((c) => ({ id: c.id, name: c.name }))}
          bookedCandidates={allCandidates
            .filter((c) => c.status === "booked" || c.status === "scheduled")
            .map((c) => ({ id: c.id, name: c.name }))}
        />
      )}

      <PipelinePoller intervalMs={3000} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Candidate card
// ---------------------------------------------------------------------------

function CandidateCard({
  candidate,
  nda,
  meeting,
  projectId,
}: {
  candidate: { id: string; name: string; email: string; status: string; rank: number | null; trustScore: string | null };
  nda?: { expiresAt: Date | null; status: string } | null;
  meeting?: { scheduledAt: Date | null; status: string } | null;
  isDemoMode: boolean;
  projectId: string;
}) {
  const now = new Date();
  const ndaExpiry = nda?.expiresAt ? new Date(nda.expiresAt) : null;
  const isNdaExpiringSoon =
    ndaExpiry && ndaExpiry.getTime() - now.getTime() < 5 * 60 * 1000;

  const scorePct = candidate.trustScore
    ? Math.round(parseFloat(candidate.trustScore) * 100)
    : null;

  return (
    <div className="text-xs rounded-lg border border-slate-800/90 bg-[#0b0f17] p-3 space-y-2 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-white truncate">{candidate.name}</p>
          <p className="text-[11px] text-slate-400 truncate">{candidate.email}</p>
        </div>
        {candidate.rank && (
          <span className="rounded border border-slate-700 bg-slate-800/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-slate-300 shrink-0">
            #{candidate.rank}
          </span>
        )}
      </div>

      {scorePct !== null && (
        <div className="flex items-center justify-between border-t border-slate-800/80 pt-2">
          <span className="text-[11px] text-slate-400">Trust Score</span>
          <span className="font-mono text-xs font-bold tabular-nums text-emerald-400">
            {scorePct} pts ({candidate.trustScore})
          </span>
        </div>
      )}

      {ndaExpiry && nda?.status === "sent" && (
        <p className={`font-mono text-[11px] tabular-nums ${isNdaExpiringSoon ? "text-rose-400" : "text-slate-300"}`}>
          NDA Expires: {formatRelativeTime(ndaExpiry)}
        </p>
      )}
      {meeting?.scheduledAt && meeting.status === "scheduled" && (
        <p className="text-slate-300 font-mono text-[11px] tabular-nums">
          Mtg: {new Date(meeting.scheduledAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}
      {(candidate.status === "found" ||
        candidate.status === "pending" ||
        candidate.status === "shortlisted") && (
        <div className="pt-1">
          <NdaGenerateButton
            candidateId={candidate.id}
            projectId={projectId}
            candidateName={candidate.name}
            label="Send NDA"
          />
        </div>
      )}
      {candidate.status === "nda_sent" && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] text-amber-300 font-medium">
            NDA awaiting signature
          </p>
          <NdaGenerateButton
            candidateId={candidate.id}
            projectId={projectId}
            candidateName={candidate.name}
            label="Get / Reissue Invite Link"
          />
        </div>
      )}
      {(candidate.status === "booking_unlocked" ||
        candidate.status === "meeting_held") && (
        <div className="pt-1">
          <HireConsultantButton
            candidateId={candidate.id}
            projectId={projectId}
            candidateName={candidate.name}
          />
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff < 0) return "expired";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
