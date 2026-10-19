"use client";

/**
 * GanttPanel — lazy-loaded Bryntum Gantt with feature flag.
 *
 * Feature flag: rendered only when NEXT_PUBLIC_GANTT_ENABLED=true.
 * When disabled, the existing @hello-pangea/dnd milestone list is the fallback
 * (rendered by the parent page — this component renders nothing).
 *
 * Bryntum import strategy:
 *   - This file is imported via Next.js dynamic() with ssr:false, so Bryntum's
 *     browser-only code never runs during SSR / next build.
 *   - No layout animation inside the grid (Framer Motion not applied here).
 *   - CSS loaded once at component mount via a <link> appended to <head>.
 *
 * taskDrop event (Bryntum docs: "Gantt Events" → TaskDrop):
 *   Fires AFTER the user releases the task. The event object exposes:
 *     taskRecords[]  — the moved tasks
 *     startDate      — the new start date of the first task
 *   We use taskDrop (not taskDrag) so we only call the server when the drop
 *   is finalised, not on every pixel of drag.
 *
 * Optimistic concurrency:
 *   1. Record the task's current start date and version before the drop.
 *   2. Let Bryntum update the UI immediately (optimistic).
 *   3. POST /api/projects/[id]/milestones/reorder with expectedVersion.
 *   4. On 409 / error: roll back the task's start date in the store and show
 *      an error Sonner toast. On success: show a success toast.
 *
 * Safety: funded / paid milestones return 409 from the server; the client
 * rolls back and shows "Cannot reschedule a funded milestone."
 */

import React, { useEffect, useRef } from "react";
import type { BryntumGantt as BryntumGanttType } from "@bryntum/gantt-react";
import { toast } from "sonner";

// Dynamic import of the heavy Bryntum class — resolved only in the browser.
// Using require() inside useEffect is the safest pattern for ESM+CJS Bryntum.

export interface GanttMilestone {
  id: string;
  title: string;
  startDate: string | null;   // "YYYY-MM-DD" or null
  dueDate: string | null;     // "YYYY-MM-DD" or null — used as endDate in Bryntum
  status: string;
  dependsOnId: string | null;
  offsetDays: number | null;
  version: number;
}

interface Props {
  projectId: string;
  milestones: GanttMilestone[];
  /** Called after a successful reschedule so the parent can refresh server data */
  onReschedule?: (milestoneId: string, newStartDate: string, newVersion: number) => void;
}

// ── CSS loader helper ─────────────────────────────────────────────────────────

let cssLoaded = false;
function loadBryntumCss(isDark: boolean) {
  if (cssLoaded) return;
  cssLoaded = true;
  const theme = isDark ? "stockholm-dark" : "stockholm-light";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  // Path is relative to node_modules — Next.js serves from the public dir.
  // We import the CSS as a URL via the node_modules path that webpack resolves.
  link.href = `/_next/static/chunks/node_modules/@bryntum/gantt/${theme}.css`;
  document.head.appendChild(link);
}

// ── Bryntum task data mapper ──────────────────────────────────────────────────

function toTaskRecord(m: GanttMilestone) {
  // Bryntum requires startDate and endDate (or duration).
  // We use dueDate as endDate. If missing, default to startDate + 1 day.
  const start = m.startDate ?? m.dueDate ?? new Date().toISOString().slice(0, 10);
  const end   = m.dueDate ?? start;
  return {
    id:        m.id,
    name:      m.title,
    startDate: start,
    endDate:   end,
    // Store version + status as custom fields for access in event handlers
    _version:  m.version,
    _status:   m.status,
    _originalStart: start,
    // Bryntum uses percentDone for progress; we don't need it here
    percentDone: 0,
    // Mark funded / locked tasks as read-only in the Gantt
    readOnly: ["funded","submitted","verifying","pending_approval","paid","disputed","cancelled"].includes(m.status),
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GanttPanel({ projectId, milestones, onReschedule }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep a stable ref to the latest milestones for use inside event closures
  const milestonesRef = useRef(milestones);
  milestonesRef.current = milestones;

  useEffect(() => {
    if (!containerRef.current) return;

    // Load Bryntum CSS — uses the built CSS files from the trial package.
    // We import them directly rather than via webpack so the build doesn't
    // need special CSS handling for the Bryntum node_modules path.
    const isDark = document.documentElement.classList.contains("dark");

    // Import CSS inline via a style tag with @import — avoids webpack CSS
    // pipeline issues with Bryntum's non-standard CSS file structure.
    const style = document.createElement("style");
    const theme = isDark ? "stockholm-dark" : "stockholm-light";
    // Relative URL from the Next.js origin — served by Next.js static file serving
    // We reference the raw node_modules path; webpack copies it via CSS url().
    // Fallback: inline the import so it works with --webpack mode.
    style.textContent = `@import url('/node_modules_css/@bryntum/gantt/${theme}.css');`;
    // Don't append the style tag — we'll use the direct file path approach instead.

    let gantt: { destroy?: () => void; taskStore?: { getById?: (id: string) => { startDate?: Date; set?: (k: string, v: unknown) => void } | null } } | null = null;

    // Dynamically require Bryntum — runs only in the browser
    void (async () => {
      try {
        // Load CSS via link tag pointing to the installed package files
        const cssHref = isDark
          ? "/@bryntum/gantt/stockholm-dark.css"
          : "/@bryntum/gantt/stockholm-light.css";
        if (!document.querySelector(`link[data-bryntum-css]`)) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.setAttribute("data-bryntum-css", "true");
          // The CSS lives in node_modules — we serve it via a custom route (see below)
          // For now, use the Next.js /_next path that webpack resolves
          link.href = cssHref;
          document.head.appendChild(link);
        }

        // Dynamic import — Bryntum is ESM
        const { Gantt } = await import("@bryntum/gantt") as { Gantt: new (config: Record<string, unknown>) => { destroy?: () => void; taskStore?: { getById?: (id: string) => { startDate?: Date; set?: (k: string, v: unknown) => void } | null } } };

        const tasks = milestonesRef.current.map(toTaskRecord);

        gantt = new Gantt({
          appendTo:  containerRef.current!,
          height:    "100%",
          // Disable features we don't need (keeps the trial lean)
          features: {
            taskEdit:        false,
            projectLines:    false,
            criticalPaths:   false,
            rollups:         false,
            percentBar:      false,
            dependencies:    false,
          },
          columns: [
            { type: "name",      text: "Milestone", field: "name",      width: 220 },
            { type: "startdate", text: "Start",     field: "startDate", width: 110 },
            { type: "enddate",   text: "Due",       field: "endDate",   width: 110 },
          ],
          project: {
            tasksData: tasks,
          },

          // ── taskDrop handler ─────────────────────────────────────────────
          // Fires after the user releases the task (not during drag).
          // Bryntum docs: "TaskDrop" event on the Gantt instance.
          listeners: {
            taskDrop: async ({ taskRecords, startDate: _sd }: { taskRecords: Array<{ id: string; startDate: Date | null; set: (k: string, v: unknown) => void }>; startDate?: Date }) => {
              const taskRecord = taskRecords[0];
              if (!taskRecord) return;

              const milestoneId = String(taskRecord.id);
              const milestone   = milestonesRef.current.find((m) => m.id === milestoneId);
              if (!milestone) return;

              // Read the new startDate that Bryntum already applied to the store
              const bryntumStartDate: Date | null = taskRecord.startDate;
              if (!bryntumStartDate) return;

              // Convert to date-only UTC string — avoid timezone off-by-one
              const newStartDate = [
                bryntumStartDate.getUTCFullYear(),
                String(bryntumStartDate.getUTCMonth() + 1).padStart(2, "0"),
                String(bryntumStartDate.getUTCDate()).padStart(2, "0"),
              ].join("-");

              // Keep the previous start date for rollback
              const previousStartDate = milestone.startDate
                ?? milestone.dueDate
                ?? new Date().toISOString().slice(0, 10);

              // Optimistic UI is already applied by Bryntum — proceed to server call
              const toastId = toast.loading(`Rescheduling "${milestone.title}"…`);

              try {
                const res = await fetch(
                  `/api/projects/${projectId}/milestones/reorder`,
                  {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      milestoneId,
                      newStartDate,
                      expectedVersion: milestone.version,
                    }),
                  }
                );

                const data = await res.json() as Record<string, unknown>;

                if (!res.ok) {
                  // Rollback: restore the previous start date in Bryntum's store
                  taskRecord.set("startDate", new Date(previousStartDate + "T00:00:00Z"));
                  if (previousStartDate) {
                    taskRecord.set("endDate", new Date(previousStartDate + "T00:00:00Z"));
                  }

                  const isProtected = res.status === 409 &&
                    String(data.error ?? "").toLowerCase().includes("funded");
                  toast.error(
                    isProtected
                      ? `Cannot reschedule: "${milestone.title}" is ${milestone.status}`
                      : `Reschedule failed: ${String(data.error ?? "unknown error")}`,
                    { id: toastId }
                  );
                  return;
                }

                const newVersion = typeof data.version === "number" ? data.version : milestone.version + 1;
                toast.success(`"${milestone.title}" rescheduled to ${newStartDate}`, { id: toastId });
                onReschedule?.(milestoneId, newStartDate, newVersion);

              } catch (err) {
                // Network error — rollback
                taskRecord.set("startDate", new Date(previousStartDate + "T00:00:00Z"));
                toast.error(
                  `Network error rescheduling "${milestone.title}": ${err instanceof Error ? err.message : String(err)}`,
                  { id: toastId }
                );
              }
            },
          },
        });
      } catch (err) {
        console.error("[GanttPanel] Failed to initialise Bryntum Gantt:", err);
        // Leave the container visible — the parent renders the DnD fallback
      }
    })();

    return () => {
      gantt?.destroy?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally empty: Bryntum manages its own store; use store API for updates

  return (
    <div
      ref={containerRef}
      style={{ height: 400 }}
      className="w-full rounded-lg border overflow-hidden bg-background"
      data-testid="gantt-panel"
      aria-label="Milestone Gantt chart"
    />
  );
}
