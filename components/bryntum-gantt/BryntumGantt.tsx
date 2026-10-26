/**
 * BryntumGantt — Client Component
 *
 * Isolation boundary: this file is the ONLY place in the project that imports
 * from `@bryntum/gantt` or `@bryntum/gantt-react`. No other file should import
 * from those packages directly.
 *
 * Architecture:
 *   app/(company)/planning/page.tsx (Server)
 *       ↓ passes plain serialisable GanttTask[] as props
 *   BryntumGantt.tsx (Client) → renders <BryntumGantt> inside a DOM boundary
 *
 * Drag-and-drop integration:
 *   The component exposes a `ganttRef` and an `onExternalDrop` callback prop.
 *   When AG Grid rows are dragged over the Gantt timeline, the parent page
 *   calls `addTask()` on the ganttRef to insert a new task record.
 *   See the "External Drag & Drop" section below for the hook-up pattern.
 *
 * AI Copilot integration:
 *   The `BryntumChatPanel` from `@bryntum/gantt-react` is wired to the
 *   `onAiMessage` prop. Swap the `handleAiMessage` stub with a real call to
 *   POST /api/gantt/ai once your backend endpoint is ready.
 *   The Bryntum scheduling engine will automatically propagate dependency
 *   changes when tasks are mutated via `project.taskStore`.
 */
"use client";

// ─── CSS ──────────────────────────────────────────────────────────────────────
// Dark theme — import exactly ONE Bryntum theme per page.
// Remove this import and add it to globals.css if another Bryntum component
// is already imported in the same page tree.
import "@bryntum/gantt/gantt.css";
import "@bryntum/gantt/stockholm-dark.css";

// ─── React ────────────────────────────────────────────────────────────────────
import React, { useRef, useCallback, useState, type RefObject } from "react";

// ─── Bryntum React wrappers ───────────────────────────────────────────────────
import { BryntumGantt as BryntumGanttWidget } from "@bryntum/gantt-react";
import type { BryntumGantt as BryntumGanttClass } from "@bryntum/gantt-react";
import GanttChatPanel from "@/components/bryntum-gantt/GanttChatPanel";

// ─── Bryntum core types ───────────────────────────────────────────────────────
import type {
  ProjectModel,
  TaskModelConfig,
  DependencyModelConfig,
  GridBase,
  Store,
  Model,
} from "@bryntum/gantt";

// ─────────────────────────────────────────────────────────────────────────────
// Public data types
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal task shape expected by this component. */
export interface GanttTask {
  id: string | number;
  name: string;
  startDate: string; // ISO date string, e.g. "2025-01-06"
  duration: number;  // in days
  percentDone?: number;
  parentId?: string | number | null;
  /** Arbitrary extra fields are forwarded to the Bryntum task record. */
  [key: string]: unknown;
}

/** Minimal dependency shape. */
export interface GanttDependency {
  id: string | number;
  fromTask: string | number;
  toTask: string | number;
  /** 0 = FinishToStart (default), 1 = StartToStart, 2 = FinishToFinish, 3 = StartToFinish */
  type?: 0 | 1 | 2 | 3;
  lag?: number;
  lagUnit?: "ms" | "s" | "mi" | "h" | "d" | "w" | "mo" | "y";
}

// ─────────────────────────────────────────────────────────────────────────────
// Component props
// ─────────────────────────────────────────────────────────────────────────────

export interface BryntumGanttProps {
  /** Initial task dataset — passed from the server component. */
  tasks?: GanttTask[];
  /** Initial dependency dataset. */
  dependencies?: GanttDependency[];
  /**
   * Called after any task is mutated (add, edit, move, resize).
   * Persist the updated task to the DB in this callback.
   */
  onTaskChange?: (task: GanttTask) => void;
  /**
   * [Drag-and-drop integration hook]
   * Called when an external item (e.g. from AG Grid) is dropped onto the
   * Gantt timeline area. The parent page is responsible for translating the
   * drop payload into a GanttTask and calling back into addTask().
   */
  onExternalDrop?: (payload: unknown, targetDate: Date) => void;
  /**
   * [AI Copilot integration hook]
   * Called when the user submits a natural-language prompt to the AI panel.
   * The parent page should POST the prompt to /api/gantt/ai and call the
   * returned mutation instructions back via `ganttRef.current?.project`.
   */
  onAiMessage?: (message: string) => Promise<string>;
  /**
   * [Drag-and-drop integration]
   * An external ref forwarded from PlanningLayout so the DragHelper can reach
   * into `ganttRef.current.instance.project.taskStore` without an extra round-
   * trip through state.  When provided, it takes precedence over the internal ref.
   */
  ganttRef?: RefObject<BryntumGanttClass | null>;
  /** Optional additional CSS class for the outer wrapper. */
  className?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default seed data (used when no tasks prop is provided)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TASKS: TaskModelConfig[] = [
  {
    id: 1,
    name: "Project kickoff",
    startDate: "2025-01-06",
    duration: 1,
    percentDone: 100,
    expanded: true,
    children: [
      { id: 2, name: "Scope definition",     startDate: "2025-01-06", duration: 3,  percentDone: 100 },
      { id: 3, name: "Team onboarding",      startDate: "2025-01-09", duration: 2,  percentDone: 60  },
    ],
  },
  {
    id: 10,
    name: "Design phase",
    startDate: "2025-01-13",
    duration: 1,
    percentDone: 40,
    expanded: true,
    children: [
      { id: 11, name: "Wireframes",          startDate: "2025-01-13", duration: 5,  percentDone: 80  },
      { id: 12, name: "Design review",       startDate: "2025-01-20", duration: 2,  percentDone: 0   },
    ],
  },
  {
    id: 20,
    name: "Development",
    startDate: "2025-01-22",
    duration: 1,
    percentDone: 0,
    expanded: true,
    children: [
      { id: 21, name: "Backend setup",       startDate: "2025-01-22", duration: 5,  percentDone: 0   },
      { id: 22, name: "Frontend build",      startDate: "2025-01-27", duration: 8,  percentDone: 0   },
      { id: 23, name: "Integration & QA",    startDate: "2025-02-04", duration: 5,  percentDone: 0   },
    ],
  },
  {
    id: 30,
    name: "Release",
    startDate: "2025-02-10",
    duration: 1,
    percentDone: 0,
    // milestone is a valid Bryntum field but not in the strict TypeScript type
    ...({ milestone: true } as Partial<TaskModelConfig>),
  },
];

const DEFAULT_DEPENDENCIES: DependencyModelConfig[] = [
  { id: 1, fromTask: 2,  toTask: 3,  type: 0 },
  { id: 2, fromTask: 3,  toTask: 11, type: 0 },
  { id: 3, fromTask: 11, toTask: 12, type: 0 },
  { id: 4, fromTask: 12, toTask: 21, type: 0 },
  { id: 5, fromTask: 21, toTask: 22, type: 0 },
  { id: 6, fromTask: 22, toTask: 23, type: 0 },
  { id: 7, fromTask: 23, toTask: 30, type: 0 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Gantt configuration constants
// ─────────────────────────────────────────────────────────────────────────────

/** Columns shown in the left-hand task grid.
 *  Cast to `any[]` because Bryntum's GridColumnConfig is a discriminated union
 *  that requires `type` to match exactly — string literals satisfy the runtime
 *  contract but not the strict compile-time union.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GANTT_COLUMNS: any[] = [
  { type: "wbs",               width: 60  },
  { type: "name",              width: 240, editor: { type: "textfield" } },
  { type: "startdate",         width: 110 },
  { type: "duration",          width: 80  },
  { type: "percentdone",       width: 90  },
  { type: "resourceassignment",width: 120 },
  { type: "addnew"                        },
];

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BryntumGantt — Project Planning Gantt chart.
 *
 * This is the primary chart component. It is intentionally kept thin:
 * all business logic (persistence, AI, drag-drop) is handled through the
 * callback props so the component stays reusable across different pages.
 */
export default function BryntumGantt({
  tasks,
  dependencies,
  onTaskChange,
  onExternalDrop,
  onAiMessage,
  ganttRef: externalGanttRef,
  className,
}: BryntumGanttProps) {
  // ── Refs ────────────────────────────────────────────────────────────────────
  /** Internal ref — used only when no external ref is provided. */
  const internalGanttRef = useRef<BryntumGanttClass | null>(null);
  /** Resolved ref: prefer the external one (from PlanningLayout). */
  const ganttRef = externalGanttRef ?? internalGanttRef;

  // ── AI Copilot state ────────────────────────────────────────────────────────
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  const addTask = (taskData: Partial<GanttTask>) => {
    const project = (ganttRef.current?.instance as unknown as { project: ProjectModel } | undefined)?.project;
    if (!project) return;
    const store = project.taskStore;
    // Build a new plain object from the public task fields. In particular, do
    // not pass an AG Grid row, DOM element, or Bryntum model to Store#add.
    const taskRecord: TaskModelConfig = {
      id:          taskData.id,
      name:        taskData.name ?? "New task",
      startDate:   taskData.startDate ?? new Date().toISOString().slice(0, 10),
      duration:    taskData.duration ?? 1,
      percentDone: taskData.percentDone ?? 0,
      parentId:    taskData.parentId ?? null,
    };

    // The store is responsible for constructing the TaskModel.
    store.add(taskRecord);
  };

  const handleGanttDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";

    const rawPayload = event.dataTransfer.getData("application/json");
    if (!rawPayload) return;

    try {
      const payload = JSON.parse(rawPayload) as Record<string, unknown>;
      const targetDate =
        ganttRef.current?.instance?.getDateFromCoordinate?.(
          event.clientX,
          "floor",
          false,
          true
        ) ?? new Date();

      onExternalDrop?.(payload, targetDate);
    } catch {
      // Ignore malformed payloads from unrelated drag sources.
    }
  };

  // ── Task change handler ──────────────────────────────────────────────────────
  // Use the official Bryntum onDataChange event signature.
  const handleDataChange = useCallback(
    (event: {
      source: GridBase;
      store: Store;
      action: "remove" | "removeAll" | "add" | "clearchanges" | "filter" | "update" | "dataset" | "replace";
      record: Model;
      records: Model[];
      changes: object;
    }) => {
      // Cast record to access its .data property (Bryntum Model stores field
      // values in a typed `data` bag at runtime).
      const record = event?.record ?? event?.records?.[0];
      const data = (record as unknown as { data?: GanttTask } | undefined)?.data;
      if (data) onTaskChange?.(data);
    },
    [onTaskChange]
  );

  // ── Prepare project data ─────────────────────────────────────────────────────
  // Map the incoming GanttTask[] into the shape Bryntum's ProjectModel expects.
  const projectTasks = tasks
    ? tasks.map((t) => ({
        id:          t.id,
        name:        t.name,
        startDate:   t.startDate,
        duration:    t.duration,
        percentDone: t.percentDone ?? 0,
        parentId:    t.parentId ?? null,
      }))
    : DEFAULT_TASKS;

  const projectDependencies = dependencies
    ? dependencies.map((d) => ({
        id:       d.id,
        fromTask: d.fromTask,
        toTask:   d.toTask,
        type:     d.type ?? 0,
        lag:      d.lag ?? 0,
        lagUnit:  d.lagUnit ?? "d",
      }))
    : DEFAULT_DEPENDENCIES;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div
      className={className}
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={handleGanttDrop}
    >
      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          display:      "flex",
          alignItems:   "center",
          gap:          8,
          padding:      "10px 16px",
          borderBottom: "1px solid #1e293b",
          background:   "#0a0e18",
          flexShrink:   0,
        }}
      >
        <span
          style={{
            color:         "#94a3b8",
            fontSize:      13,
            fontWeight:    600,
            letterSpacing: "0.02em",
          }}
        >
          ◈ Project Planning
        </span>

        <span style={{ flex: 1 }} />

        <ToolbarButton
          label={aiPanelOpen ? "✕ Close AI" : "✦ AI Copilot"}
          title="Toggle AI scheduling assistant"
          onClick={() => setAiPanelOpen((o) => !o)}
          active={aiPanelOpen}
        />

        <ToolbarButton
          label="↩ Undo"
          title="Undo (Ctrl+Z)"
          onClick={() => ganttRef.current?.instance?.project.stm?.undo()}
        />
        <ToolbarButton
          label="↪ Redo"
          title="Redo (Ctrl+Shift+Z)"
          onClick={() => ganttRef.current?.instance?.project.stm?.redo()}
        />
        <ToolbarButton
          label="+ Task"
          title="Add a new root-level task"
          onClick={() => addTask({ name: "New task" })}
        />
      </div>

      {aiPanelOpen && (
        <GanttChatPanel onAiMessage={onAiMessage} />
      )}

      {/* ── Bryntum Gantt widget ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, height: "100%", minWidth: 0, overflow: "hidden" }}>
        <BryntumGanttWidget
          ref={ganttRef}

          // ── Project data ────────────────────────────────────────────────────
          tasks={projectTasks}
          dependencies={projectDependencies}

          // ── Columns ─────────────────────────────────────────────────────────
          columns={GANTT_COLUMNS}

          // ── Time axis ───────────────────────────────────────────────────────
          viewPreset="weekAndDayLetter"
          startDate="2025-01-01"
          endDate="2025-03-31"

          // ── Visual ──────────────────────────────────────────────────────────
          rowHeight={40}
          columnLines={true}
          barMargin={6}

          // ── Scheduling engine ───────────────────────────────────────────────
          // Enables the Bryntum scheduling engine so that moving one task
          // automatically propagates lag-aware delays to dependents.
          enableTransactionalFeatures={true}
          detectCSSCompatibilityIssues={false}

          // ── Features ───────────────────────────────────────────────────────
          // Critical path highlighting — enabled by default; set to true to
          // ensure it is on regardless of persisted state.
          criticalPathsFeature={{ disabled: false }}
          // Percent-done drag handle on task bars
          percentBarFeature={{ disabled: false }}
          // Allow in-cell editing
          cellEditFeature={{ disabled: false }}
          // Task context menu
          taskMenuFeature={{ disabled: false }}
          // Dependencies are passed as data above; creation via terminal
          // dragging is enabled by default in the Gantt widget.

          // ── Drag: internal row reorder (built-in) ───────────────────────────
          // The Gantt's native task drag is enabled by default.
          // For cross-component drag-and-drop with AG Grid, use DragHelper
          // (see the [ DRAG & DROP PLACEHOLDER ] comments above).

          // ── License ─────────────────────────────────────────────────────────
          // Set NEXT_PUBLIC_BRYNTUM_LICENSE_KEY in .env.local.
          // When the trial period ends the Gantt will show a watermark until
          // a valid key is provided.

          // ── Event handlers ─────────────────────────────────────────────────
          onDataChange={handleDataChange}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny toolbar button — no shared UI library to keep the component isolated
// ─────────────────────────────────────────────────────────────────────────────

function ToolbarButton({
  label,
  title,
  onClick,
  active = false,
}: {
  label: string;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        background:   active ? "#1e293b" : "transparent",
        border:       `1px solid ${active ? "#334155" : "#1e293b"}`,
        borderRadius: 6,
        color:        active ? "#e2e8f0" : "#64748b",
        cursor:       "pointer",
        fontSize:     12,
        padding:      "3px 10px",
        transition:   "color 0.15s, border-color 0.15s, background 0.15s",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.color       = "#e2e8f0";
        el.style.borderColor = "#334155";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.color       = active ? "#e2e8f0" : "#64748b";
        el.style.borderColor = active ? "#334155" : "#1e293b";
      }}
    >
      {label}
    </button>
  );
}
