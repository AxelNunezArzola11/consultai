/**
 * PlanningLayout — Client Component
 *
 * Orchestrates the split-screen layout for the /planning route:
 *   ┌────────────────────┬─────────────────────────────────────┐
 *   │  Unscheduled Tasks │  Bryntum Gantt (Project Timeline)   │
 *   │  (AG Grid)         │                                     │
 *   └────────────────────┴─────────────────────────────────────┘
 *
 * Drag & Drop integration:
 *   1. The Bryntum DragHelper listens for mousedown on `.ag-row` elements
 *      inside the AG Grid panel.
 *   2. It clones the row as a drag proxy and tracks mouse movement.
 *   3. `dropTargetSelector` marks the Gantt timeline subgrid as
 *      the valid drop zone.
 *   4. On drop, the grabbed row element's data-id is used to look up the
 *      task from the unscheduled list.  The task is injected into Bryntum's
 *      TaskStore via `addTask()` and removed from the AG Grid state.
 *
 * TypeScript notes:
 *   – DragHelper is imported from @bryntum/gantt (the core package that
 *     BryntumGantt.tsx already declares as the isolation boundary).
 *   – The ganttRef is threaded down from here so only this file manages
 *     the cross-component communication; BryntumGantt remains stateless
 *     regarding drag-drop.
 */
"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import dynamicImport from "next/dynamic";
import type { BryntumGantt as BryntumGanttClass } from "@bryntum/gantt-react";
import type { GanttTask, GanttDependency } from "@/components/bryntum-gantt/BryntumGantt";
import UnscheduledTasksGrid, {
  DEFAULT_UNSCHEDULED_TASKS,
  type UnscheduledTask,
} from "@/components/bryntum-gantt/UnscheduledTasksGrid";

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic import for BryntumGantt (ssr:false is enforced in the server page,
// but we also guard here in case PlanningLayout is ever used client-side only)
// ─────────────────────────────────────────────────────────────────────────────

const BryntumGanttDynamic = dynamicImport(
  () => import("@/components/bryntum-gantt/BryntumGantt"),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          width:          "100%",
          height:         "100%",
          background:     "#0a0e18",
          color:          "#94a3b8",
          fontFamily:     "system-ui, sans-serif",
          fontSize:       14,
        }}
      >
        Loading project plan…
      </div>
    ),
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanningLayoutProps {
  /** Pre-shaped tasks from the server — passed through to BryntumGantt */
  initialTasks?: GanttTask[];
  /** Pre-shaped dependencies from the server */
  initialDependencies?: GanttDependency[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Unique ID helper for newly dropped tasks
// ─────────────────────────────────────────────────────────────────────────────

let _dropSeq = 0;
function nextDropId(): string {
  return `dropped-${++_dropSeq}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlanningLayout({
  initialTasks,
  initialDependencies,
}: PlanningLayoutProps) {
  // ── Unscheduled task state ─────────────────────────────────────────────────
  const [unscheduledTasks, setUnscheduledTasks] = useState<UnscheduledTask[]>(
    DEFAULT_UNSCHEDULED_TASKS
  );

  // ── Gantt ref — used to reach into the Bryntum project's taskStore ─────────
  // The ref is stored here (the orchestrator) rather than inside BryntumGantt
  // so the DragHelper drop handler can call addTask without prop-drilling.
  const ganttRef = useRef<BryntumGanttClass | null>(null);

  // ── Panel DOM refs — needed to set up DragHelper's outerElement ───────────
  const splitRef      = useRef<HTMLDivElement>(null);

  // ── Track unscheduled tasks in a ref so the DragHelper closure is stable ──
  const unscheduledRef = useRef<UnscheduledTask[]>(unscheduledTasks);
  useEffect(() => {
    unscheduledRef.current = unscheduledTasks;
  }, [unscheduledTasks]);

  // ── addTask helper — injects a task record into Bryntum's TaskStore ────────
  const addTask = useCallback((taskData: Partial<GanttTask>): boolean => {
    const project = ganttRef.current?.instance?.project;
    if (!project) {
      console.error("[Planning] Cannot schedule task: Bryntum project is not ready.");
      return false;
    }

    // Copy only serializable task fields from the AG Grid row. Never pass the
    // row element, row node, or AG Grid data object through to Bryntum.
    const normalizedTask: GanttTask = {
      id: taskData.id ?? nextDropId(),
      name: taskData.name ?? "Dropped task",
      startDate: taskData.startDate ?? new Date().toISOString().slice(0, 10),
      duration: taskData.duration ?? 1,
      percentDone: taskData.percentDone ?? 0,
      parentId: taskData.parentId ?? null,
    };

    project.taskStore.add(normalizedTask);
    return true;
  }, []);

  // ── Set up the Bryntum DragHelper after the DOM is ready ──────────────────
  useEffect(() => {
    if (!splitRef.current) return;

    let dragHelper: { destroy(): void } | null = null;
    let disposed = false;

    // DragHelper is a Bryntum core class — import it lazily (browser-only).
    import("@bryntum/gantt").then(({ DragHelper }) => {
      if (!splitRef.current || disposed) return;

      dragHelper = new DragHelper({
        // The outer boundary for drag operations — the whole split panel.
        outerElement: splitRef.current,

        // Target AG Grid rendered rows as the draggable elements.
        targetSelector: ".ag-row",

        // Match the timeline subgrid and its time-axis cells, not only the
        // canvas layer. The latter does not cover every valid hover target.
        dropTargetSelector: ".b-timeline-subgrid, .b-grid-subgrid-timeaxis, .b-sch-timeaxis-cell",

        // Clone the row as a visual proxy; keep the original row in the grid.
        cloneTarget:          true,
        mode:                 "translateXY",
        dragThreshold:        5,
        hideOriginalElement:  false,

        listeners: {
          /**
           * Fires on drop — inject task into Bryntum and remove from AG Grid.
           * NOTE: Bryntum's DragHelperListeners "drop" type does NOT include
           * the raw DOM event. Date resolution uses the proxy element's page X.
           */
          drop({
            context,
          }: {
            context: {
              element: HTMLElement;
              grabbed: HTMLElement;
              target:  HTMLElement;
              relatedElements: HTMLElement[];
              valid:   boolean;
            };
          }) {
            if (!context.valid) return;

            // 1. Resolve which task was dragged using the row's data-row-id.
            //    AG Grid 32 sets `row-id` on the .ag-row element via getRowId().
            const row = context.grabbed.closest<HTMLElement>(".ag-row");
            const rowId =
              row?.getAttribute("row-id") ??
              row?.getAttribute("data-row-id") ??
              context.grabbed.getAttribute("row-id") ??
              context.grabbed.getAttribute("data-row-id") ??
              (context.grabbed.dataset?.rowId ?? null);

            const task = rowId
              ? unscheduledRef.current.find((t) => String(t.id) === String(rowId))
              : undefined;

            if (!task) {
              console.error("[Planning] Cannot schedule task: dragged AG Grid row has no matching task.");
              return;
            }

            // 2. Determine the target date from the proxy element's X position.
            const proxyRect = context.element.getBoundingClientRect();
            const dropX = proxyRect.left + proxyRect.width / 2;

            const ganttInstance = ganttRef.current?.instance as
              | {
                  getDateFromCoordinate?: (
                    x: number,
                    roundingMethod?: "floor" | "round" | "ceil",
                    local?: boolean,
                    allowOutOfRange?: boolean,
                  ) => Date;
                }
              | undefined;

            const targetDate: Date | null = ganttInstance?.getDateFromCoordinate
              ? ganttInstance.getDateFromCoordinate(dropX, "floor", false, true)
              : null;

            const startDate = targetDate
              ? targetDate.toISOString().slice(0, 10)
              : new Date().toISOString().slice(0, 10);

            const inserted = addTask({
              id: task.id,
              name: task.name,
              startDate,
              duration: Number(task.estimatedDays) || 1,
              percentDone: 0,
            });

            if (inserted) {
              setUnscheduledTasks((prev) => prev.filter((t) => String(t.id) !== String(task.id)));
            }
          },
        },
      });
    });

    return () => {
      disposed = true;
      dragHelper?.destroy();
    };
    // addTask is stable (useCallback with no deps); run only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Stable onExternalDrop for BryntumGantt (kept for backwards-compat) ─────
  const handleExternalDrop = useCallback(
    (payload: unknown, date: Date) => {
      console.debug("[Gantt] external drop:", payload, "at", date);
    },
    []
  );

  // ── AI copilot stub ────────────────────────────────────────────────────────
  const handleAiMessage = useCallback(async (message: string): Promise<string> => {
    console.debug("[Gantt AI Copilot]", message);
    return `🤖 AI stub — wire to /api/gantt/ai. Received: "${message}"`;
  }, []);

  // ── Task change handler ────────────────────────────────────────────────────
  const handleTaskChange = useCallback((task: GanttTask) => {
    console.debug("[Gantt] task changed:", task);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div
      ref={splitRef}
      className="flex min-h-[calc(100vh-80px)] min-w-0 w-full flex-row overflow-hidden bg-slate-950"
    >
      {/* ── Left panel: Unscheduled Tasks (AG Grid) ───────────────────────── */}
      <div
        className="flex w-80 shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/50"
      >
        <UnscheduledTasksGrid tasks={unscheduledTasks} />
      </div>

      {/* ── Divider hint ────────────────────────────────────────────────────── */}
      <div
        className="w-px shrink-0 bg-slate-800"
      />

      {/* ── Right panel: Bryntum Gantt timeline ──────────────────────────── */}
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/50"
      >
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <BryntumGanttDynamic
          // Thread the ref through via a callback ref pattern: BryntumGantt
          // exposes no forwardRef, so we read ganttRef from the rendered
          // widget's instance inside the drop handler instead.
          tasks={initialTasks && initialTasks.length > 0 ? initialTasks : undefined}
          dependencies={
            initialDependencies && initialDependencies.length > 0
              ? initialDependencies
              : undefined
          }
          onTaskChange={handleTaskChange}
          onExternalDrop={handleExternalDrop}
          onAiMessage={handleAiMessage}
          // Pass our ganttRef down so the DragHelper can call into the store.
          // BryntumGantt accepts an optional ganttRef prop (added below).
            ganttRef={ganttRef}
          />
        </div>
      </div>
    </div>
  );
}
