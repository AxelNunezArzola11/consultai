"use client";

/**
 * MeetingScheduler — Schedule review meetings with consultants.
 *
 * Features:
 * - Lists existing meetings for the project (scheduled, completed, cancelled)
 * - "Schedule a meeting" form: pick candidate, date/time, paste Cal.com link
 * - Opens Cal.com booking link in a new tab for the actual scheduling
 * - Shows meeting status with Join link if bookingLink is present
 *
 * Used on the milestones page and project detail pages.
 */

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// ── Types ──────────────────────────────────────────────────────────────────

interface Candidate {
  id: string;
  name: string;
  email: string;
}

interface Meeting {
  id: string;
  candidateId: string;
  scheduledAt: string | null;
  status: string;
  calCancelReason: string | null;
  bookingLink: string | null;
  createdAt: string;
  candidate: Candidate | null;
}

interface Props {
  projectId: string;
  /** Pre-loaded candidate list (optional — fetched from API if not provided) */
  candidates?: Candidate[];
}

// ── Status display helpers ─────────────────────────────────────────────────

const STATUS_CFG = {
  scheduled:  { label: "Scheduled",  variant: "default" as const,      icon: "📅" },
  completed:  { label: "Completed",  variant: "default" as const,      icon: "✅" },
  cancelled:  { label: "Cancelled",  variant: "destructive" as const,  icon: "🚫" },
  no_show:    { label: "No-show",    variant: "secondary" as const,     icon: "⚠️" },
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day:   "numeric",
    year:  "numeric",
    hour:  "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

// ── Component ──────────────────────────────────────────────────────────────

export function MeetingScheduler({ projectId, candidates: propCandidates }: Props) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>(propCandidates ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // ── Fetch meetings ─────────────────────────────────────────────────────
  const loadMeetings = useCallback(async () => {
    try {
      const res = await fetch(`/api/meetings?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json() as { meetings: Meeting[] };
      setMeetings(data.meetings ?? []);
    } catch {
      setLoadError("Could not load meetings.");
    }
  }, [projectId]);

  // ── Fetch candidates if not pre-loaded ────────────────────────────────
  useEffect(() => {
    if (propCandidates && propCandidates.length > 0) return;
    fetch(`/api/candidates/search?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { results: Candidate[] }) => setCandidates(d.results ?? []))
      .catch(() => {});
  }, [projectId, propCandidates]);

  useEffect(() => { void loadMeetings(); }, [loadMeetings]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Review Meetings</p>
          {meetings !== null && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {meetings.length === 0 ? "No meetings scheduled yet" : `${meetings.length} meeting${meetings.length !== 1 ? "s" : ""}`}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant={showForm ? "outline" : "default"}
          className="h-7 text-xs"
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? "Cancel" : "+ Schedule Meeting"}
        </Button>
      </div>

      {/* Schedule form */}
      {showForm && (
        <ScheduleForm
          projectId={projectId}
          candidates={candidates}
          onSuccess={() => {
            setShowForm(false);
            void loadMeetings();
          }}
        />
      )}

      {/* Error */}
      {loadError && (
        <p className="text-xs text-destructive">{loadError}</p>
      )}

      {/* Meeting list */}
      {meetings !== null && meetings.length > 0 && (
        <div className="space-y-2">
          {meetings.map((m) => (
            <MeetingRow key={m.id} meeting={m} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Schedule form ──────────────────────────────────────────────────────────

function ScheduleForm({
  projectId,
  candidates,
  onSuccess,
}: {
  projectId: string;
  candidates: Candidate[];
  onSuccess: () => void;
}) {
  const [candidateId, setCandidateId] = useState(candidates[0]?.id ?? "");
  const [scheduledAt, setScheduledAt] = useState("");
  const [bookingLink, setBookingLink] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build a Cal.com booking URL from env or let company paste their own
  const calLink = process.env.NEXT_PUBLIC_CAL_BOOKING_URL;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!candidateId) {
      setError("Please select a candidate.");
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          candidateId,
          scheduledAt: scheduledAt || undefined,
          bookingLink: bookingLink || undefined,
        }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        setError(String(data.error ?? `Request failed (${res.status})`));
        setLoading(false);
        return;
      }

      // If there's a booking link, open it for the company to complete scheduling
      const link = bookingLink || calLink;
      if (link) {
        window.open(link, "_blank", "noopener,noreferrer");
      }

      onSuccess();
    } catch {
      setError("Network error — please try again.");
      setLoading(false);
    }
  }

  return (
    <Card className="bg-muted/30">
      <CardContent className="pt-4 pb-3">
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Candidate selector */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Candidate</label>
            {candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">No candidates available for this project.</p>
            ) : (
              <select
                value={candidateId}
                onChange={(e) => setCandidateId(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.email})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Date/time */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Date &amp; Time <span className="text-muted-foreground font-normal">(optional — confirm via Cal.com)</span>
            </label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Booking link */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Cal.com booking link <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <input
              type="url"
              value={bookingLink}
              onChange={(e) => setBookingLink(e.target.value)}
              placeholder={calLink ?? "https://cal.com/your-link/30min"}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-[10px] text-muted-foreground">
              Paste your Cal.com event link. Clicking "Schedule" will open it in a new tab.
            </p>
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              className="text-xs h-7"
              disabled={loading || candidates.length === 0}
            >
              {loading ? (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Saving…
                </span>
              ) : (
                bookingLink || calLink ? "Schedule & Open Cal.com →" : "Save Meeting"
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Single meeting row ─────────────────────────────────────────────────────

function MeetingRow({ meeting }: { meeting: Meeting }) {
  const cfg = STATUS_CFG[meeting.status as keyof typeof STATUS_CFG] ?? {
    label: meeting.status,
    variant: "outline" as const,
    icon: "📋",
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm">
      <span className="text-base flex-shrink-0" aria-hidden="true">{cfg.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate">
            {meeting.candidate?.name ?? "Unknown candidate"}
          </span>
          <Badge variant={cfg.variant} className="text-[10px] h-4 px-1.5">
            {cfg.label}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {meeting.scheduledAt ? formatDate(meeting.scheduledAt) : "Time TBD"}
          {meeting.candidate?.email && ` · ${meeting.candidate.email}`}
        </p>
        {meeting.calCancelReason && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Reason: {meeting.calCancelReason}
          </p>
        )}
      </div>
      {meeting.bookingLink && meeting.status === "scheduled" && (
        <a
          href={meeting.bookingLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 text-xs text-primary underline underline-offset-2 hover:no-underline"
        >
          Join
        </a>
      )}
    </div>
  );
}
