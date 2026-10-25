/**
 * UnscheduledTasksGrid — AG Grid panel for the Planning split-screen.
 *
 * Renders a list of "unscheduled" tasks. Rows are made draggable via the
 * HTML5 drag API so the PlanningLayout DragHelper can pick them up and drop
 * them onto the Bryntum Gantt timeline.
 *
 * Architecture:
 *   PlanningLayout.tsx
 *       ├── UnscheduledTasksGrid.tsx  ← this file
 *       └── BryntumGantt.tsx
 *
 * Drag protocol:
 *   Each AG Grid row wraps its GanttTask data into
 *   dataTransfer["application/json"] on dragstart.
 *   PlanningLayout reads that payload on drop and calls addTask() on the
 *   Bryntum component, then removes the row from this grid's state.
 */
"use client";

import React, { useCallback, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  GridReadyEvent,
  GridApi,
  RowDragEndEvent,
  DragStartedEvent,
} from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface UnscheduledTask {
  id: string | number;
  name: string;
  priority: "High" | "Medium" | "Low";
  estimatedDays: number;
  /** Arbitrary extra fields forwarded to Bryntum on drop */
  [key: string]: unknown;
}

export interface UnscheduledTasksGridProps {
  /** Controlled list of unscheduled tasks; managed by the parent */
  tasks: UnscheduledTask[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Default seed data
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_UNSCHEDULED_TASKS: UnscheduledTask[] = [
  { id: "u-1", name: "Requirements gathering",  priority: "High",   estimatedDays: 3 },
  { id: "u-2", name: "Competitive analysis",    priority: "Medium", estimatedDays: 2 },
  { id: "u-3", name: "Stakeholder interviews",  priority: "High",   estimatedDays: 2 },
  { id: "u-4", name: "API contract draft",      priority: "Medium", estimatedDays: 4 },
  { id: "u-5", name: "Performance audit",       priority: "Low",    estimatedDays: 1 },
  { id: "u-6", name: "Security review",         priority: "High",   estimatedDays: 2 },
  { id: "u-7", name: "Documentation update",    priority: "Low",    estimatedDays: 3 },
  { id: "u-8", name: "User acceptance testing", priority: "Medium", estimatedDays: 5 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Priority badge renderer
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, string> = {
  High:   "#ef4444",
  Medium: "#f59e0b",
  Low:    "#22c55e",
};

function PriorityBadge({ value }: { value: string }) {
  const color = PRIORITY_COLORS[value] ?? "#64748b";
  return (
    <span
      style={{
        display:      "inline-flex",
        alignItems:   "center",
        background:   `${color}22`,
        border:       `1px solid ${color}55`,
        borderRadius: 4,
        color,
        fontSize:     11,
        fontWeight:   600,
        padding:      "1px 8px",
        letterSpacing: "0.03em",
      }}
    >
      {value}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Column definitions
// ─────────────────────────────────────────────────────────────────────────────

const COL_DEFS: ColDef<UnscheduledTask>[] = [
  {
    headerName:       "",
    field:            "id",
    width:            32,
    maxWidth:         32,
    rowDrag:          true,
    suppressHeaderMenuButton: true,
    sortable:         false,
    resizable:        false,
  },
  {
    headerName:  "Task",
    field:       "name",
    flex:        1,
    minWidth:    140,
    sortable:    true,
  },
  {
    headerName:  "Priority",
    field:       "priority",
    width:       90,
    sortable:    true,
    cellRenderer: (params: { value: string }) => <PriorityBadge value={params.value} />,
  },
  {
    headerName:  "Days",
    field:       "estimatedDays",
    width:       60,
    sortable:    true,
    type:        "numericColumn",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function UnscheduledTasksGrid({
  tasks,
}: UnscheduledTasksGridProps) {
  const gridApiRef = useRef<GridApi<UnscheduledTask> | null>(null);

  const onGridReady = useCallback((event: GridReadyEvent<UnscheduledTask>) => {
    gridApiRef.current = event.api;
  }, []);

  // When AG Grid's built-in row-drag ends outside the grid (no target), we use
  // the DragHelper in PlanningLayout for the actual drop — this handler is only
  // a safety no-op to prevent the row from being re-sorted unexpectedly.
  const onRowDragEnd = useCallback((_event: RowDragEndEvent<UnscheduledTask>) => {
    // Drop is handled externally by the Bryntum DragHelper in PlanningLayout.
  }, []);

  const onRowDragStart = useCallback((event: DragStartedEvent<UnscheduledTask>) => {
    const target = event.target as HTMLElement | null;
    const rowEl = target?.closest<HTMLElement>(".ag-row");
    if (rowEl) {
      rowEl.setAttribute("data-drag-source", "unscheduled-task");
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Panel header */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-950 px-4 py-2.5"
      >
        <span
          className="text-sm font-semibold tracking-wide text-slate-400"
        >
          ⊞ Unscheduled Tasks
        </span>
        <span
          className="ml-auto rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-400"
        >
          {tasks.length}
        </span>
      </div>

      {/* Grid */}
      <div
        className="ag-theme-alpine-dark"
        style={{ flex: 1, minHeight: 0 }}
      >
        <AgGridReact<UnscheduledTask>
          rowData={tasks}
          columnDefs={COL_DEFS}
          onGridReady={onGridReady}
          onDragStarted={onRowDragStart}
          onRowDragEnd={onRowDragEnd}
          rowDragManaged={false}
          rowDragEntireRow={false}
          suppressMoveWhenRowDragging={true}
          animateRows={true}
          rowHeight={40}
          headerHeight={36}
          suppressCellFocus={true}
          getRowId={(params) => String(params.data.id)}
        />
      </div>

      {/* Drop hint */}
      <div
        className="shrink-0 border-t border-slate-800 bg-slate-950 px-4 py-2 text-center text-xs text-slate-500"
      >
        Drag a row onto the Gantt timeline to schedule it
      </div>
    </div>
  );
}
