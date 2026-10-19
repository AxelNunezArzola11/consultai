"use client";

/**
 * GanttPanelLazy — Next.js dynamic() wrapper for GanttPanel.
 *
 * Bryntum requires browser APIs (window, document) and cannot run during SSR.
 * This wrapper uses Next.js dynamic() with ssr:false so the heavy bundle is
 * never loaded during next build or server rendering.
 *
 * Feature flag: only renders when NEXT_PUBLIC_GANTT_ENABLED=true.
 * When the flag is off, renders null so the parent's DnD fallback shows instead.
 */

import dynamic from "next/dynamic";
import type { GanttMilestone } from "./GanttPanel";

// Lazy-load GanttPanel — ssr:false prevents Bryntum from running on the server
const GanttPanel = dynamic(
  () => import("./GanttPanel").then((mod) => mod.GanttPanel),
  {
    ssr: false,
    loading: () => (
      <div
        className="w-full h-[400px] rounded-lg border bg-muted/30 flex items-center justify-center"
        aria-label="Loading Gantt chart"
      >
        <span className="text-sm text-muted-foreground animate-pulse">Loading Gantt…</span>
      </div>
    ),
  }
);

interface Props {
  projectId: string;
  milestones: GanttMilestone[];
  onReschedule?: (milestoneId: string, newStartDate: string, newVersion: number) => void;
}

export function GanttPanelLazy({ projectId, milestones, onReschedule }: Props) {
  // Feature flag — off by default; set NEXT_PUBLIC_GANTT_ENABLED=true to enable
  if (process.env.NEXT_PUBLIC_GANTT_ENABLED !== "true") {
    return null;
  }

  return (
    <GanttPanel
      projectId={projectId}
      milestones={milestones}
      onReschedule={onReschedule}
    />
  );
}
