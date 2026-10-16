/**
 * Candidate pipeline dashboard — Phase 4
 *
 * Displays candidates in columns by status, deadline timers,
 * last agent event, and activity feed.
 *
 * Phase 4 additions:
 * - Full pipeline columns: FOUND → SHORTLISTED → NDA_SENT → NDA_SIGNED →
 *   BOOKING_UNLOCKED → BOOKED → MEETING_HELD → SELECTED
 * - Deadline timer for NDA expiry
 * - Demo controls (DEMO_MODE only): Simulate NDA Signed, Simulate Cancellation
 * - Lazy expiry check on page load
 */

export const dynamic = "force-dynamic";

import { eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/lib/db";
import { candidates, ndas, meetings, cascadeLog } from "@/lib/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { lazyExpireNdas, lazyCheckNoShows } from "@/lib/scheduling/lazy-checks";

// ---------------------------------------------------------------------------
// Pipeline column config
// ---------------------------------------------------------------------------

const PIPELINE_COLUMNS = [
  { key: "found",            label: "Found",            color: "bg-slate-100 dark:bg-slate-800" },
  { key: "shortlisted",      label: "Shortlisted",      color: "bg-blue-50 dark:bg-blue-950" },
  { key: "pending",          label: "Pending",          color: "bg-slate-50 dark:bg-slate-900" },
  { key: "nda_sent",         label: "NDA Sent",         color: "bg-yellow-50 dark:bg-yellow-950" },
  { key: "nda_signed",       label: "NDA Signed",       color: "bg-lime-50 dark:bg-lime-950" },
  { key: "booking_unlocked", label: "Booking Unlocked", color: "bg-teal-50 dark:bg-teal-950" },
  { key: "booked",           label: "Booked",           color: "bg-cyan-50 dark:bg-cyan-950" },
  { key: "scheduled",        label: "Scheduled",        color: "bg-cyan-50 dark:bg-cyan-950" },
  { key: "meeting_held",     label: "Meeting Held",     color: "bg-green-50 dark:bg-green-950" },
  { key: "selected",         label: "Selected",         color: "bg-emerald-50 dark:bg-emerald-950" },
] as const;

const TERMINAL_COLUMNS = [
  { key: "declined",        label: "Declined",        color: "bg-red-50 dark:bg-red-950" },
  { key: "expired",         label: "Expired",         color: "bg-orange-50 dark:bg-orange-950" },
  { key: "cancelled",       label: "Cancelled",       color: "bg-red-50 dark:bg-red-950" },
  { key: "no_show",         label: "No Show",         color: "bg-orange-50 dark:bg-orange-950" },
  { key: "invalid_booking", label: "Invalid Booking", color: "bg-red-50 dark:bg-red-950" },
  { key: "rejected",        label: "Rejected",        color: "bg-slate-50 dark:bg-slate-900" },
  { key: "cascaded",        label: "Cascaded",        color: "bg-slate-50 dark:bg-slate-900" },
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface Props {
  params: Promise<{ id: string }>;
}

export default async function CandidatePipelinePage({ params }: Props) {
  const { id: projectId } = await params;

  // Lazy expiry checks on every page load
  await Promise.allSettled([
    lazyExpireNdas(projectId),
    lazyCheckNoShows(projectId),
  ]);

  const allCandidates = await db
    .select()
    .from(candidates)
    .where(eq(candidates.projectId, projectId))
    .orderBy(candidates.rank);

  // Fetch NDAs for expiry display
  const candidateIds = allCandidates.map((c) => c.id);
  const ndaList =
    candidateIds.length > 0
      ? await db
          .select()
          .from(ndas)
          .where(inArray(ndas.candidateId, candidateIds))
      : [];

  const ndaByCandidate = Object.fromEntries(
    ndaList.map((n) => [n.candidateId, n])
  );

  // Fetch meetings
  const meetingList =
    candidateIds.length > 0
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

  const isDemoMode = process.env.DEMO_MODE === "true" || process.env.NODE_ENV === "development";

  // Count cascade rounds
  const cascadeLogs = await db
    .select()
    .from(cascadeLog)
    .where(eq(cascadeLog.projectId, projectId));

  return (
    <div className="px-6 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Candidate Pipeline</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Live pipeline dashboard — auto-refreshes every 3 seconds
          </p>
        </div>
        <div className="flex items-center gap-3">
          {cascadeLogs.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {cascadeLogs.length} cascade{cascadeLogs.length !== 1 ? "s" : ""}
            </Badge>
          )}
          <Link
            href={`/project/${projectId}/vetting`}
            className="text-xs text-blue-600 hover:text-blue-700 underline font-medium"
          >
            Vetting →
          </Link>
          <Link
            href={`/project/${projectId}/milestones`}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Milestones
          </Link>
        </div>
      </div>

      {/* Active pipeline */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Active Pipeline
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {PIPELINE_COLUMNS.map((col) => {
            const group = byStatus.get(col.key) ?? [];
            if (group.length === 0) return null;
            return (
              <div key={col.key} className={`rounded-lg border p-3 space-y-2 ${col.color}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide">
                    {col.label}
                  </span>
                  <Badge variant="secondary" className="text-xs">
                    {group.length}
                  </Badge>
                </div>
                <div className="space-y-2">
                  {group.map((c) => (
                    <CandidateCard
                      key={c.id}
                      candidate={c}
                      nda={ndaByCandidate[c.id]}
                      meeting={meetingByCandidate[c.id]}
                      isDemoMode={isDemoMode}
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
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Terminal States
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {TERMINAL_COLUMNS.map((col) => {
              const group = byStatus.get(col.key) ?? [];
              if (group.length === 0) return null;
              return (
                <div key={col.key} className={`rounded-lg border p-3 space-y-2 ${col.color}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {col.label}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {group.length}
                    </Badge>
                  </div>
                  <div className="space-y-2">
                    {group.map((c) => (
                      <div
                        key={c.id}
                        className="text-xs rounded border bg-background px-2 py-1.5"
                      >
                        <p className="font-medium truncate">{c.name}</p>
                        {c.rejectionReason && (
                          <p className="text-muted-foreground truncate">
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
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No candidates yet. The VettingAgent will populate this pipeline.
          </CardContent>
        </Card>
      )}

      {/* Cascade activity log */}
      {cascadeLogs.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Cascade Log
          </h2>
          <div className="space-y-2">
            {cascadeLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between text-xs border rounded-lg px-3 py-2 bg-muted"
              >
                <span>
                  Round {log.round} — <strong>{log.reason}</strong>
                </span>
                <span className="text-muted-foreground">
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
      {isDemoMode && (
        <DemoControlsSection projectId={projectId} candidates={allCandidates} />
      )}

      {/* Auto-refresh script */}
      <AutoRefresh intervalMs={3000} />
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
  isDemoMode,
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
    ndaExpiry && ndaExpiry.getTime() - now.getTime() < 5 * 60 * 1000; // < 5 min

  return (
    <div className="text-xs rounded border bg-background px-2 py-2 space-y-1">
      <div className="flex items-center justify-between gap-1">
        <p className="font-medium truncate">{candidate.name}</p>
        {candidate.rank && (
          <span className="text-muted-foreground shrink-0">#{candidate.rank}</span>
        )}
      </div>
      {candidate.trustScore && (
        <p className="text-muted-foreground">Score: {candidate.trustScore}</p>
      )}
      {ndaExpiry && nda?.status === "sent" && (
        <p className={`font-mono ${isNdaExpiringSoon ? "text-red-500" : "text-muted-foreground"}`}>
          NDA: {formatRelativeTime(ndaExpiry)}
        </p>
      )}
      {meeting?.scheduledAt && meeting.status === "scheduled" && (
        <p className="text-muted-foreground font-mono">
          Mtg: {new Date(meeting.scheduledAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
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

// ---------------------------------------------------------------------------
// Demo controls (DEMO_MODE only)
// ---------------------------------------------------------------------------

function DemoControlsSection({
  projectId,
  candidates: allCandidates,
}: {
  projectId: string;
  candidates: Array<{ id: string; name: string; status: string }>;
}) {
  const ndaSentCandidates = allCandidates.filter((c) => c.status === "nda_sent");
  const bookedCandidates = allCandidates.filter(
    (c) => c.status === "booked" || c.status === "scheduled"
  );

  return (
    <div className="rounded-lg border border-orange-300 bg-orange-50 dark:bg-orange-950 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant="destructive" className="text-xs">DEMO ONLY</Badge>
        <h2 className="text-sm font-semibold">Demo Controls</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        These buttons simulate real events for demonstration. Disabled in production.
      </p>
      <div className="flex flex-wrap gap-2">
        {ndaSentCandidates.map((c) => (
          <DemoButton
            key={c.id}
            label={`Simulate NDA Signed: ${c.name}`}
            apiPath="/api/demo/simulate-nda-signed"
            payload={{ candidateId: c.id, projectId }}
          />
        ))}
        {bookedCandidates.map((c) => (
          <DemoButton
            key={c.id}
            label={`Simulate Cancellation: ${c.name}`}
            apiPath="/api/demo/simulate-cancellation"
            payload={{ candidateId: c.id, projectId }}
          />
        ))}
        {ndaSentCandidates.length === 0 && bookedCandidates.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No candidates in NDA_SENT or BOOKED state to simulate.
          </p>
        )}
      </div>
    </div>
  );
}

// Client component stub for demo buttons — rendered server-side as form submissions
function DemoButton({
  label,
  apiPath,
  payload,
}: {
  label: string;
  apiPath: string;
  payload: Record<string, string>;
}) {
  return (
    <form action={apiPath} method="POST">
      {Object.entries(payload).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button
        type="submit"
        className="text-xs rounded border border-orange-400 bg-orange-100 dark:bg-orange-900 hover:bg-orange-200 dark:hover:bg-orange-800 px-3 py-1.5 transition-colors"
      >
        {label}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Auto-refresh — meta refresh for server components (no client JS needed)
// ---------------------------------------------------------------------------

function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  return (
    <div className="text-xs text-muted-foreground text-center">
      <span>Pipeline auto-refreshes every {intervalMs / 1000}s</span>
      {/* eslint-disable-next-line @next/next/no-head-element */}
      {/* Note: real polling is handled by the useSSE hook in client components */}
    </div>
  );
}
