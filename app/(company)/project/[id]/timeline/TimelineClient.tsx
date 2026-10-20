"use client";

/**
 * TimelineClient — client-side timeline wrapper for the Timeline tab.
 *
 * Renders:
 *   1. GanttPanelLazy (Bryntum Gantt, ssr:false) when NEXT_PUBLIC_GANTT_ENABLED=true
 *   2. A pure-CSS dark-themed proportional timeline as primary visual (always)
 *
 * Dark-first design: all surfaces use bg-slate-900 / border-slate-800 tokens.
 * Bars use proportional width % with a minWidth guard (2.5rem) so labels never
 * overflow the container or get clipped on short durations.
 */

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { GanttMilestone } from "@/components/canvas/GanttPanel";
import { VettingAIHarness } from "@/components/agent/VettingAIHarness";
import type { SmartRescheduleResult } from "@/components/agent/VettingAIHarness";
import { toast } from "sonner";

// Lazy-load Bryntum Gantt (ssr:false inside GanttPanelLazy already)
const GanttPanelLazy = dynamic(
  () => import("@/components/canvas/GanttPanelLazy").then((m) => ({ default: m.GanttPanelLazy })),
  { ssr: false }
);

// ── Status colours ─────────────────────────────────────────────────────────

const STATUS_BAR: Record<string, string> = {
  planned:          "bg-slate-600",
  funded:           "bg-indigo-600",
  submitted:        "bg-amber-600",
  verifying:        "bg-amber-600",
  pending_approval: "bg-amber-600",
  paid:             "bg-emerald-600",
  disputed:         "bg-rose-600",
  cancelled:        "bg-slate-700",
  failed:           "bg-rose-700",
  returned:         "bg-slate-700",
};

const STATUS_TEXT: Record<string, string> = {
  planned:          "text-slate-300",
  funded:           "text-indigo-300",
  submitted:        "text-amber-300",
  verifying:        "text-amber-300",
  pending_approval: "text-amber-300",
  paid:             "text-emerald-300",
  disputed:         "text-rose-300",
  cancelled:        "text-slate-400",
  failed:           "text-rose-400",
  returned:         "text-slate-400",
};

const STATUS_LABELS: Record<string, string> = {
  planned:          "Planned",
  funded:           "Held",
  submitted:        "Submitted",
  verifying:        "Verifying",
  pending_approval: "Awaiting Approval",
  paid:             "Paid",
  disputed:         "Disputed",
  cancelled:        "Cancelled",
  failed:           "Failed",
  returned:         "Returned",
};

// ── Timeline builder ───────────────────────────────────────────────────────

interface BarData {
  id: string;
  label: string;
  status: string;
  startPct: number;
  widthPct: number;
  startLabel: string;
  endLabel: string;
}

function buildBars(milestones: GanttMilestone[]): { bars: BarData[]; rangeLabel: string } {
  // Collect all valid dates
  const dates: Date[] = [];
  for (const m of milestones) {
    if (m.startDate) dates.push(new Date(m.startDate + "T00:00:00Z"));
    if (m.dueDate)   dates.push(new Date(m.dueDate   + "T00:00:00Z"));
  }

  if (dates.length === 0) {
    // No dates — fall back to offsetDays-based proportional sizing
    return buildOffsetBars(milestones);
  }

  const minTime = Math.min(...dates.map((d) => d.getTime()));
  const maxTime = Math.max(...dates.map((d) => d.getTime()));
  const span = maxTime - minTime || 1;

  const fmt = (iso: string) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

  const bars: BarData[] = milestones.map((m) => {
    const start = m.startDate
      ? new Date(m.startDate + "T00:00:00Z").getTime()
      : minTime;
    const end = m.dueDate
      ? new Date(m.dueDate + "T00:00:00Z").getTime()
      : start;

    const duration = Math.max(end - start, span * 0.02); // at least 2% width
    const startPct = ((start - minTime) / span) * 100;
    const widthPct = (duration / span) * 100;

    return {
      id:         m.id,
      label:      m.title,
      status:     m.status,
      startPct:   Math.max(0, Math.min(startPct, 95)),
      widthPct:   Math.max(widthPct, 3),
      startLabel: m.startDate ? fmt(m.startDate) : "—",
      endLabel:   m.dueDate   ? fmt(m.dueDate)   : "—",
    };
  });

  const rangeLabel = `${fmt(milestones.find((m) => m.startDate)?.startDate ?? new Date().toISOString().slice(0, 10))} → ${fmt(milestones.findLast((m) => m.dueDate)?.dueDate ?? new Date().toISOString().slice(0, 10))}`;

  return { bars, rangeLabel };
}

function buildOffsetBars(milestones: GanttMilestone[]): { bars: BarData[]; rangeLabel: string } {
  const totalDays = Math.max(...milestones.map((_, i) => i + 1), 1) * 30; // fallback: 30d/milestone
  let cursor = 0;

  const bars: BarData[] = milestones.map((m, i) => {
    const duration = 30; // assume 30 days per milestone when no dates
    const startPct = (cursor / totalDays) * 100;
    const widthPct = (duration / totalDays) * 100;
    cursor += duration;
    return {
      id:         m.id,
      label:      m.title,
      status:     m.status,
      startPct,
      widthPct:   Math.max(widthPct, 3),
      startLabel: `M${i + 1} start`,
      endLabel:   `M${i + 1} end`,
    };
  });

  return { bars, rangeLabel: "No dates set" };
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  milestones: GanttMilestone[];
}

export function TimelineClient({ projectId, milestones }: Props) {
  const [versionMap, setVersionMap] = useState<Record<string, number>>({});
  // AI smart reschedule overlay — milestones with AI-proposed dates (not yet saved)
  const [aiOverride, setAiOverride] = useState<Record<string, { startDate: string | null; dueDate: string | null }>>({});

  const hydratedMilestones: GanttMilestone[] = milestones.map((m) => {
    const override = aiOverride[m.id];
    return {
      ...m,
      version:   versionMap[m.id] ?? m.version,
      startDate: override?.startDate !== undefined ? override.startDate : m.startDate,
      dueDate:   override?.dueDate   !== undefined ? override.dueDate   : m.dueDate,
    };
  });

  const handleReschedule = useCallback(
    (milestoneId: string, _newStartDate: string, newVersion: number) => {
      setVersionMap((prev) => ({ ...prev, [milestoneId]: newVersion }));
    },
    []
  );

  // Handle AI smart-reschedule — apply the proposed dates as an optimistic overlay
  const handleSmartReschedule = useCallback((result: SmartRescheduleResult) => {
    const overrides: Record<string, { startDate: string | null; dueDate: string | null }> = {};
    for (const u of result.updates) {
      overrides[u.id] = { startDate: u.startDate, dueDate: u.dueDate };
    }
    setAiOverride(overrides);
    toast.success(`AI timeline applied: ${result.message}`, { duration: 4000 });
  }, []);

  const hasAiOverride = Object.keys(aiOverride).length > 0;

  const { bars, rangeLabel } = buildBars(hydratedMilestones);
  const ganttEnabled = process.env.NEXT_PUBLIC_GANTT_ENABLED === "true";

  // Milestones in the shape expected by the AI harness
  const harnessMillestones = hydratedMilestones.map((m) => ({
    id:        m.id,
    title:     m.title,
    startDate: m.startDate,
    dueDate:   m.dueDate,
  }));

  return (
    <div className="space-y-6">
      {/* ── AI Override banner ──────────────────────────────────────────── */}
      {hasAiOverride && (
        <div className="rounded-lg border border-primary/30 bg-primary/8 px-4 py-3 flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-primary text-sm">⟳</span>
            <p className="text-foreground font-medium">
              AI-proposed timeline applied.{" "}
              <span className="text-muted-foreground font-normal">
                Drag milestones in the Gantt to save permanently, or
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAiOverride({})}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1 hover:bg-muted/40 transition-colors"
          >
            ✕ Revert
          </button>
        </div>
      )}

      {/* ── Bryntum Gantt (feature-flagged) ──────────────────────────────── */}
      {ganttEnabled && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
          <div className="px-4 pt-4 pb-2 border-b border-slate-800">
            <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
              ▤ Interactive Gantt
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Drag bars to reschedule. Funded milestones are locked.
            </p>
          </div>
          <div className="p-4" style={{ minHeight: 440 }}>
            <GanttPanelLazy
              projectId={projectId}
              milestones={hydratedMilestones}
              onReschedule={handleReschedule}
            />
          </div>
        </div>
      )}

      {/* ── CSS-based proportional timeline (always rendered) ─────────────── */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
              ▤ Milestone Timeline
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Proportional view — {rangeLabel}
            </p>
          </div>
          <span className="text-[11px] text-slate-500 tabular-nums">
            {milestones.length} milestone{milestones.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Timeline rows */}
        <div className="px-4 py-4 space-y-3">
          {/* Axis labels */}
          <div className="flex items-center justify-between text-[10px] text-slate-600 px-0 mb-1 ml-14">
            <span>Start</span>
            <span>End</span>
          </div>

          {bars.map((bar, i) => {
            const barColor   = STATUS_BAR[bar.status]  ?? "bg-slate-600";
            const labelColor = STATUS_TEXT[bar.status] ?? "text-slate-300";
            const statusLbl  = STATUS_LABELS[bar.status] ?? bar.status;

            return (
              <div key={bar.id} className="flex items-center gap-3 group">
                {/* Index label */}
                <div className="w-10 shrink-0 text-right">
                  <span className="text-xs font-semibold text-slate-500">M{i + 1}</span>
                </div>

                {/* Bar track */}
                <div className="flex-1 relative h-8 bg-slate-800 rounded-md overflow-hidden">
                  <div
                    className={`absolute top-0 h-full rounded-md ${barColor} opacity-90 flex items-center overflow-hidden`}
                    style={{
                      left:     `${bar.startPct}%`,
                      width:    `${bar.widthPct}%`,
                      minWidth: "2.5rem",
                    }}
                  >
                    <span
                      className="px-2 text-white text-[11px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis leading-none"
                      title={bar.label}
                    >
                      {bar.label}
                    </span>
                  </div>
                </div>

                {/* Meta column */}
                <div className="w-36 shrink-0 hidden sm:flex items-center gap-2">
                  <span className={`text-[10px] font-medium ${labelColor}`}>
                    {statusLbl}
                  </span>
                  <span className="text-[10px] text-slate-600">
                    {bar.startLabel} → {bar.endLabel}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="px-4 pb-4 pt-1 border-t border-slate-800 flex flex-wrap gap-x-4 gap-y-1.5">
          {[
            { key: "planned",  label: "Planned",   color: "bg-slate-600" },
            { key: "funded",   label: "Held",      color: "bg-indigo-600" },
            { key: "paid",     label: "Paid",      color: "bg-emerald-600" },
            { key: "submitted",label: "Submitted", color: "bg-amber-600" },
            { key: "disputed", label: "Disputed",  color: "bg-rose-600" },
          ].map(({ key, label, color }) => (
            <div key={key} className="flex items-center gap-1.5">
              <span className={`inline-block w-2.5 h-2.5 rounded-sm ${color}`} />
              <span className="text-[10px] text-slate-500">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Milestone detail table ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
        <div className="px-4 pt-4 pb-3 border-b border-slate-800">
          <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
            Milestone Details
          </p>
        </div>
        <div className="divide-y divide-slate-800">
          {milestones.map((m, i) => {
            const statusLbl  = STATUS_LABELS[m.status] ?? m.status;
            const labelColor = STATUS_TEXT[m.status]   ?? "text-slate-400";
            const dotColor   = STATUS_BAR[m.status]    ?? "bg-slate-600";
            return (
              <div
                key={m.id}
                className="grid grid-cols-[2rem_1fr_auto_auto_auto] gap-3 items-center px-4 py-3 text-sm hover:bg-slate-800/40 transition-colors"
              >
                <span className="text-xs font-bold text-slate-600">M{i + 1}</span>
                <span className="font-medium text-slate-100 truncate">{m.title}</span>
                <span className="text-xs text-slate-500 tabular-nums hidden md:block">
                  {m.startDate ?? "—"}
                </span>
                <span className="text-xs text-slate-500 tabular-nums hidden md:block">
                  {m.dueDate   ?? "—"}
                </span>
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full border border-slate-700 bg-slate-800 ${labelColor}`}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
                  {statusLbl}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {/* ── AI Harness (floating chat, Gantt-focused) ───────────────────── */}
      <VettingAIHarness
        projectId={projectId}
        milestones={harnessMillestones}
        onSmartReschedule={handleSmartReschedule}
      />
    </div>
  );
}
