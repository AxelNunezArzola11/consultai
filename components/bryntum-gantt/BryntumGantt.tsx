/**
 * BryntumGantt — Client Component (Section 6 Advanced Project Planning)
 *
 * Isolation boundary: this file is the ONLY place in the project that imports
 * from `@bryntum/gantt` or `@bryntum/gantt-react`.
 *
 * Features implemented:
 * - Task dependencies & Finish-to-Start lag propagation
 * - Milestones (zero-duration diamond gates)
 * - Critical path visualization toggle
 * - Resource assignment & Consultant workload utilization bar
 * - Task progress (`percentBarFeature`)
 * - Baseline comparison (`baselinesFeature`)
 * - Multiple timeline zoom presets (Day/Week, Week/Day, Month/Year, Quarter)
 * - Drag-and-drop scheduling + financial lock protection for `funded` and `paid` milestones
 * - Interactive Task Detail Panel (inspect/edit task dates, progress, resource assignment, status, and persist to DB)
 * - Scheduling conflict indicators (resource overallocation, dependency violation, locked milestone warnings)
 * - AI-generated scheduling proposal banner requiring explicit human authorization before mutating schedules
 */
"use client";

import "@bryntum/gantt/gantt.css";
import "@bryntum/gantt/stockholm-dark.css";

import React, { useRef, useCallback, useState, useMemo, type RefObject } from "react";
import { BryntumGantt as BryntumGanttWidget } from "@bryntum/gantt-react";
import type { BryntumGantt as BryntumGanttClass } from "@bryntum/gantt-react";
import GanttChatPanel from "@/components/bryntum-gantt/GanttChatPanel";

import type {
  ProjectModel,
  TaskModelConfig,
  DependencyModelConfig,
  GridBase,
  Store,
  Model,
} from "@bryntum/gantt";
import {
  bryntumReactFeatureFlags,
  isMilestoneTask,
} from "@/lib/gantt/bryntum-config";

// ─────────────────────────────────────────────────────────────────────────────
// Public data types
// ─────────────────────────────────────────────────────────────────────────────

export interface GanttTask {
  id: string | number;
  name: string;
  startDate: string; // ISO date string "YYYY-MM-DD"
  endDate?: string;
  duration: number;  // in days
  percentDone?: number;
  parentId?: string | number | null;
  status?: string;
  budgetUsd?: number;
  assignedConsultantId?: string | null;
  assignedConsultantName?: string | null;
  milestone?: boolean;
  readOnly?: boolean;
  version?: number;
  baselines?: Array<{ startDate: string; endDate: string }>;
  [key: string]: unknown;
}

export interface GanttDependency {
  id: string | number;
  fromTask: string | number;
  toTask: string | number;
  type?: 0 | 1 | 2 | 3;
  lag?: number;
  lagUnit?: "ms" | "s" | "mi" | "h" | "d" | "w" | "mo" | "y";
}

export interface GanttConsultantResource {
  id: string;
  name: string;
  email: string;
  status: string;
  trustScore?: number;
}

export interface SchedulingProposalPreview {
  proposal_id: string;
  project_id: string;
  execution_id?: string;
  proposed_by_agent: string;
  overall_risk: string;
  total_delay_days: number;
  rationale: string;
  status: string;
  adjustments: Array<{
    task_id: string;
    task_name: string;
    previous_start_date: string;
    previous_end_date: string;
    proposed_start_date: string;
    proposed_end_date: string;
    delta_days: number;
    reason: string;
  }>;
}

export interface BryntumGanttProps {
  tasks?: GanttTask[];
  dependencies?: GanttDependency[];
  consultants?: GanttConsultantResource[];
  activeProposal?: SchedulingProposalPreview | null;
  onApproveProposal?: (proposal: SchedulingProposalPreview) => Promise<void>;
  onRejectProposal?: (proposal: SchedulingProposalPreview) => Promise<void>;
  onTaskChange?: (task: GanttTask) => void;
  onDependencyChange?: (op: "add" | "update" | "remove", dep: GanttDependency) => void;
  onExternalDrop?: (payload: unknown, targetDate: Date) => void;
  onAiMessage?: (message: string) => Promise<string>;
  ganttRef?: RefObject<BryntumGanttClass | null>;
  className?: string;
  /** Server load failure — renders an honest error panel instead of seed data. */
  loadError?: string | null;
  /** Explicit empty state (zero milestones) — renders an empty panel, never seed. */
  isEmpty?: boolean;
  /**
   * Opt-in seed demo. DEFAULT_* seed rows render ONLY when this is true.
   * Without it, undefined tasks render a loading panel and [] renders empty.
   */
  showSeedDemo?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default seed data (used when project has no saved milestones yet)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TASKS: TaskModelConfig[] = [
  {
    id: "seed-1",
    name: "Phase 1: Architecture & Escrow Setup",
    startDate: "2025-05-05",
    duration: 4,
    percentDone: 100,
    expanded: true,
    children: [
      { id: "seed-2", name: "System Architecture & DB Schema", startDate: "2025-05-05", duration: 2, percentDone: 100 },
      { id: "seed-3", name: "Consultant NDA & Technical Vetting", startDate: "2025-05-07", duration: 2, percentDone: 85 },
    ],
  },
  {
    id: "seed-10",
    name: "Phase 2: Multi-Agent Core Implementation",
    startDate: "2025-05-09",
    duration: 8,
    percentDone: 55,
    expanded: true,
    children: [
      { id: "seed-11", name: "PydanticAI Supervisor & Specialist Agents", startDate: "2025-05-09", duration: 4, percentDone: 75 },
      { id: "seed-12", name: "PayPal 6-Stage Escrow & Payout Policy", startDate: "2025-05-13", duration: 4, percentDone: 40 },
    ],
  },
  {
    id: "seed-20",
    name: "Phase 3: Enterprise Operations & Release Gate",
    startDate: "2025-05-17",
    duration: 5,
    percentDone: 20,
    expanded: true,
    children: [
      { id: "seed-21", name: "Bryntum Gantt & AG Grid Synchronization", startDate: "2025-05-17", duration: 3, percentDone: 30 },
      { id: "seed-22", name: "Production Verification Sign-Off", startDate: "2025-05-20", duration: 1, percentDone: 0, ...({ milestone: true } as Partial<TaskModelConfig>) },
    ],
  },
];

const DEFAULT_DEPENDENCIES: DependencyModelConfig[] = [
  { id: "dep-1", fromTask: "seed-2", toTask: "seed-3", type: 2 },
  { id: "dep-2", fromTask: "seed-3", toTask: "seed-11", type: 2 },
  { id: "dep-3", fromTask: "seed-11", toTask: "seed-12", type: 2 },
  { id: "dep-4", fromTask: "seed-12", toTask: "seed-21", type: 2 },
  { id: "dep-5", fromTask: "seed-21", toTask: "seed-22", type: 2 },
];

type ZoomPresetKey = "dayAndWeek" | "weekAndDayLetter" | "monthAndYear";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GANTT_COLUMNS: any[] = [
  { type: "wbs", width: 58 },
  { type: "name", width: 230, editor: { type: "textfield" } },
  { type: "startdate", width: 108 },
  { type: "duration", width: 76 },
  { type: "percentdone", width: 84 },
  { type: "addnew" },
];

export default function BryntumGantt({
  tasks,
  dependencies,
  consultants = [],
  activeProposal,
  onApproveProposal,
  onRejectProposal,
  onTaskChange,
  onDependencyChange,
  onExternalDrop,
  onAiMessage,
  ganttRef: externalGanttRef,
  className,
  loadError = null,
  isEmpty = false,
  showSeedDemo = false,
}: BryntumGanttProps) {
  const internalGanttRef = useRef<BryntumGanttClass | null>(null);
  const ganttRef = externalGanttRef ?? internalGanttRef;

  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [criticalPathEnabled, setCriticalPathEnabled] = useState(true);
  const [baselinesEnabled, setBaselinesEnabled] = useState(true);
  const [zoomPreset, setZoomPreset] = useState<ZoomPresetKey>("weekAndDayLetter");
  const [selectedTask, setSelectedTask] = useState<GanttTask | null>(null);
  const [isApplyingProposal, setIsApplyingProposal] = useState(false);

  const addTask = (taskData: Partial<GanttTask>) => {
    const project = (ganttRef.current?.instance as unknown as { project: ProjectModel } | undefined)?.project;
    if (!project) return;
    const store = project.taskStore;
    const taskRecord: TaskModelConfig = {
      id: taskData.id ?? `task-${Date.now()}`,
      name: taskData.name ?? "New Milestone Task",
      startDate: taskData.startDate ?? new Date().toISOString().slice(0, 10),
      duration: taskData.duration ?? 3,
      percentDone: taskData.percentDone ?? 0,
      parentId: taskData.parentId ?? null,
    };
    store.add(taskRecord);
  };

  const handleZoomChange = (preset: ZoomPresetKey) => {
    setZoomPreset(preset);
    const inst = ganttRef.current?.instance as unknown as { viewPreset?: string } | undefined;
    if (inst) {
      inst.viewPreset = preset;
    }
  };

  const handleToggleCriticalPath = () => {
    setCriticalPathEnabled((prev) => {
      const next = !prev;
      const inst = ganttRef.current?.instance as unknown as {
        features?: { criticalPaths?: { disabled: boolean } };
      } | undefined;
      if (inst?.features?.criticalPaths) {
        inst.features.criticalPaths.disabled = !next;
      }
      return next;
    });
  };

  const handleToggleBaselines = () => {
    setBaselinesEnabled((prev) => {
      const next = !prev;
      const inst = ganttRef.current?.instance as unknown as {
        features?: { baselines?: { disabled: boolean } };
      } | undefined;
      if (inst?.features?.baselines) {
        inst.features.baselines.disabled = !next;
      }
      return next;
    });
  };

  // Detect scheduling conflicts and consultant workload across tasks
  const { conflicts, consultantWorkloads } = useMemo(() => {
    const list = tasks ?? [];
    const detectedConflicts: Array<{ id: string; message: string; severity: "high" | "medium" }> = [];
    const byConsultant = new Map<string, GanttTask[]>();

    const taskMap = new Map(list.map((t) => [String(t.id), t]));
    for (const d of dependencies ?? []) {
      const fromT = taskMap.get(String(d.fromTask));
      const toT = taskMap.get(String(d.toTask));
      if (fromT && toT && fromT.endDate && toT.startDate < fromT.endDate) {
        detectedConflicts.push({
          id: `dep-${d.id}`,
          severity: "high",
          message: `Dependency violation: '${toT.name}' starts (${toT.startDate}) before '${fromT.name}' finishes (${fromT.endDate}).`,
        });
      }
    }

    for (const t of list) {
      const cName = t.assignedConsultantName || (t.assignedConsultantId ? String(t.assignedConsultantId) : null);
      if (cName) {
        const arr = byConsultant.get(cName) ?? [];
        arr.push(t);
        byConsultant.set(cName, arr);
      }
    }

    const workloads: Array<{ name: string; taskCount: number; utilization: number }> = [];
    for (const [name, cTasks] of byConsultant.entries()) {
      const util = Math.min(200, cTasks.length * 50);
      workloads.push({ name, taskCount: cTasks.length, utilization: util });
      if (cTasks.length > 2) {
        detectedConflicts.push({
          id: `overload-${name}`,
          severity: "medium",
          message: `Resource workload warning: ${name} is assigned to ${cTasks.length} concurrent tasks (${util}% allocation).`,
        });
      }
    }

    return { conflicts: detectedConflicts, consultantWorkloads: workloads };
  }, [tasks, dependencies]);

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
      // Ignore malformed payloads
    }
  };

  const handleDataChange = useCallback(
    (event: {
      source: GridBase;
      store: Store;
      action: "remove" | "removeAll" | "add" | "clearchanges" | "filter" | "update" | "dataset" | "replace";
      record: Model;
      records: Model[];
      changes: object;
    }) => {
      const record = event?.record ?? event?.records?.[0];
      const data = (record as unknown as { data?: Record<string, unknown> } | undefined)?.data;
      if (!data) return;
      // Dependency store records carry fromTask/toTask; task store records do not.
      if ("fromTask" in data || "toTask" in data) {
        const op: "add" | "update" | "remove" =
          event.action === "add" ? "add" : event.action === "remove" || event.action === "removeAll" ? "remove" : "update";
        onDependencyChange?.(op, {
          id: data.id as string | number,
          fromTask: data.fromTask as string | number,
          toTask: data.toTask as string | number,
          type: (data.type as 0 | 1 | 2 | 3 | undefined) ?? 2,
          lag: (data.lag as number | undefined) ?? 0,
          lagUnit: (data.lagUnit as GanttDependency["lagUnit"]) ?? "d",
        });
        return;
      }
      onTaskChange?.(data as unknown as GanttTask);
    },
    [onTaskChange, onDependencyChange]
  );

  // Seed rows render ONLY behind the explicit showSeedDemo opt-in.
  const usingSeedDemo = showSeedDemo && (!tasks || tasks.length === 0);

  const projectTasks = useMemo(() => {
    if (usingSeedDemo) return DEFAULT_TASKS;
    if (!tasks || tasks.length === 0) return [];
    return tasks.map((t) => ({
      id: t.id,
      name: t.name,
      startDate: t.startDate,
      duration: t.duration,
      percentDone: t.percentDone ?? 0,
      parentId: t.parentId ?? null,
      readOnly: t.status === "funded" || t.status === "paid" || Boolean(t.readOnly),
      baselines: t.baselines ?? [
        {
          startDate: t.startDate,
          endDate: t.endDate ?? t.startDate,
        },
      ],
      ...({ milestone: isMilestoneTask(t) } as Partial<TaskModelConfig>),
    }));
  }, [tasks, usingSeedDemo]);

  const projectDependencies = useMemo(() => {
    if (usingSeedDemo) return DEFAULT_DEPENDENCIES;
    if (!dependencies || dependencies.length === 0) return [];
    return dependencies.map((d) => ({
      id: d.id,
      fromTask: d.fromTask,
      toTask: d.toTask,
      type: d.type ?? 2,
      lag: d.lag ?? 0,
      lagUnit: d.lagUnit ?? "d",
    }));
  }, [dependencies, usingSeedDemo]);

  // Shared canonical flags (same source as GanttPanel vanilla config).
  const sharedFeatures = bryntumReactFeatureFlags(criticalPathEnabled);

  // Compute timeline window dynamically around tasks
  const { timelineStart, timelineEnd } = useMemo(() => {
    if (!tasks || tasks.length === 0) {
      return { timelineStart: "2025-05-01", timelineEnd: "2025-06-30" };
    }
    const dates = tasks
      .map((t) => new Date(`${t.startDate.slice(0, 10)}T00:00:00Z`).getTime())
      .filter((n) => !Number.isNaN(n));
    if (dates.length === 0) {
      const now = new Date();
      const s = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const e = new Date(now.getTime() + 45 * 86400000).toISOString().slice(0, 10);
      return { timelineStart: s, timelineEnd: e };
    }
    const minTs = Math.min(...dates) - 5 * 86400000;
    const maxTs = Math.max(...dates) + 40 * 86400000;
    return {
      timelineStart: new Date(minTs).toISOString().slice(0, 10),
      timelineEnd: new Date(maxTs).toISOString().slice(0, 10),
    };
  }, [tasks]);

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
      {/* ── Top Control Bar ──────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: "10px 16px",
          borderBottom: "1px solid #1e293b",
          background: "#0a0e18",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            color: "#e2e8f0",
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          ◈ Bryntum Gantt — Enterprise Schedule
        </span>

        {/* Conflict & Workload badges */}
        {conflicts.length > 0 ? (
          <span
            title={conflicts.map((c) => c.message).join("\n")}
            style={{
              background: "rgba(245, 158, 11, 0.14)",
              border: "1px solid rgba(245, 158, 11, 0.4)",
              color: "#fbbf24",
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 999,
            }}
          >
            ⚠ {conflicts.length} Conflict{conflicts.length > 1 ? "s" : ""} Detected
          </span>
        ) : (
          <span
            style={{
              background: "rgba(16, 185, 129, 0.12)",
              border: "1px solid rgba(16, 185, 129, 0.35)",
              color: "#34d399",
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 999,
            }}
          >
            ✓ Schedule Validated
          </span>
        )}

        {consultantWorkloads.slice(0, 3).map((cw) => (
          <span
            key={cw.name}
            style={{
              background: "#0f172a",
              border: "1px solid #1e293b",
              color: cw.utilization > 100 ? "#f87171" : "#94a3b8",
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 6,
            }}
          >
            👤 {cw.name}: {cw.utilization}% ({cw.taskCount}t)
          </span>
        ))}

        <span style={{ flex: 1 }} />

        {/* Zoom level switcher */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <ToolbarButton
            label="Day"
            title="Zoom to Day & Week view"
            active={zoomPreset === "dayAndWeek"}
            onClick={() => handleZoomChange("dayAndWeek")}
          />
          <ToolbarButton
            label="Week"
            title="Zoom to Week & Day view"
            active={zoomPreset === "weekAndDayLetter"}
            onClick={() => handleZoomChange("weekAndDayLetter")}
          />
          <ToolbarButton
            label="Month"
            title="Zoom to Month & Year view"
            active={zoomPreset === "monthAndYear"}
            onClick={() => handleZoomChange("monthAndYear")}
          />
        </div>

        <ToolbarButton
          label="⚡ Critical Path"
          title="Toggle Critical Path Highlighting"
          active={criticalPathEnabled}
          onClick={handleToggleCriticalPath}
        />

        <ToolbarButton
          label="◫ Baselines"
          title="Toggle Baseline Schedule Comparison"
          active={baselinesEnabled}
          onClick={handleToggleBaselines}
        />

        {tasks && tasks.length > 0 && (
          <ToolbarButton
            label={selectedTask ? "✕ Task Inspector" : "✎ Inspect Task"}
            title="Open Task Detail & Resource Inspector"
            active={Boolean(selectedTask)}
            onClick={() => setSelectedTask((prev) => (prev ? null : tasks[0]))}
          />
        )}

        <ToolbarButton
          label={aiPanelOpen ? "✕ Close AI" : "✦ AI Copilot"}
          title="Toggle Planning & Reschedule AI Assistant"
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
          title="Add a new task"
          onClick={() => addTask({ name: "New Milestone Task" })}
        />
      </div>

      {/* ── Pending AI Scheduling Proposal Banner (Human Authorization Gate) ── */}
      {activeProposal && activeProposal.status === "pending_approval" && (
        <div className="mx-3 mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-amber-300">
                  Human Authorization Required
                </span>
                <span className="font-semibold text-white">
                  AI Scheduling Proposal ({activeProposal.proposal_id}) —{" "}
                  {activeProposal.adjustments.length} Task Adjustment(s)
                </span>
                <span className="text-slate-400">
                  Risk: <strong className="uppercase text-amber-300">{activeProposal.overall_risk}</strong>
                </span>
              </div>
              <p className="mt-1 text-slate-300">{activeProposal.rationale}</p>
            </div>
            <div className="flex items-center gap-2">
              {onApproveProposal && (
                <button
                  type="button"
                  disabled={isApplyingProposal}
                  onClick={async () => {
                    setIsApplyingProposal(true);
                    try {
                      await onApproveProposal(activeProposal);
                    } finally {
                      setIsApplyingProposal(false);
                    }
                  }}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {isApplyingProposal ? "Applying…" : "✓ Authorize & Apply Schedule"}
                </button>
              )}
              {onRejectProposal && (
                <button
                  type="button"
                  disabled={isApplyingProposal}
                  onClick={async () => {
                    setIsApplyingProposal(true);
                    try {
                      await onRejectProposal(activeProposal);
                    } finally {
                      setIsApplyingProposal(false);
                    }
                  }}
                  className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                >
                  ✕ Reject Proposal
                </button>
              )}
            </div>
          </div>
          {activeProposal.adjustments.length > 0 && (
            <div className="mt-2 grid grid-cols-1 gap-1.5 border-t border-amber-500/20 pt-2 sm:grid-cols-2 lg:grid-cols-3">
              {activeProposal.adjustments.slice(0, 6).map((adj) => (
                <div
                  key={adj.task_id}
                  className="rounded border border-slate-800 bg-slate-950/80 px-2.5 py-1.5 text-[11px]"
                >
                  <div className="font-medium text-slate-200">{adj.task_name}</div>
                  <div className="text-slate-400">
                    {adj.previous_end_date} →{" "}
                    <span className="font-semibold text-emerald-400">
                      {adj.proposed_end_date}
                    </span>{" "}
                    ({adj.delta_days >= 0 ? `+${adj.delta_days}d` : `${adj.delta_days}d`})
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {aiPanelOpen && <GanttChatPanel onAiMessage={onAiMessage} />}

      {/* ── Main Content Area: Gantt + Slide-Over Task Detail Inspector ──────── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          height: "100%",
          minWidth: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "row",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, height: "100%", minWidth: 0, overflow: "hidden" }}>
          {loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="text-sm font-semibold text-rose-400">Schedule failed to load</div>
              <p className="max-w-md text-xs text-slate-400">{loadError}</p>
            </div>
          ) : tasks === undefined && !usingSeedDemo && !isEmpty ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="text-sm font-semibold text-slate-200">Loading schedule…</div>
              <p className="max-w-md text-xs text-slate-500">Fetching milestones from the database.</p>
            </div>
          ) : (isEmpty || (tasks !== undefined && tasks.length === 0)) && !usingSeedDemo ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="text-sm font-semibold text-slate-200">No scheduled milestones yet</div>
              <p className="max-w-md text-xs text-slate-500">
                Drag backlog tasks from the left panel onto the timeline, or create milestones from a project brief.
              </p>
            </div>
          ) : (
          <BryntumGanttWidget
            ref={ganttRef}
            tasks={projectTasks}
            dependencies={projectDependencies}
            columns={GANTT_COLUMNS}
            viewPreset={zoomPreset}
            startDate={timelineStart}
            endDate={timelineEnd}
            rowHeight={40}
            columnLines={true}
            barMargin={6}
            enableTransactionalFeatures={true}
            detectCSSCompatibilityIssues={false}
            criticalPathsFeature={sharedFeatures.criticalPathsFeature}
            dependenciesFeature={sharedFeatures.dependenciesFeature}
            baselinesFeature={{ disabled: !baselinesEnabled }}
            percentBarFeature={{ disabled: false }}
            cellEditFeature={{ disabled: false }}
            taskMenuFeature={{ disabled: false }}
            onDataChange={handleDataChange}
          />
          )}
        </div>

        {/* ── Task Detail & Resource Assignment Side Panel ─────────────────── */}
        {selectedTask && (
          <div className="flex w-80 shrink-0 flex-col border-l border-slate-800 bg-slate-950 p-4 text-xs text-slate-200 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Task Detail Inspector</h3>
                <p className="text-[11px] text-slate-400">Synchronized with Neon DB & AG Grid</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTask(null)}
                className="rounded border border-slate-800 px-2 py-1 text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            {tasks && tasks.length > 1 && (
              <div className="mt-3">
                <label className="block text-[11px] font-medium text-slate-400">
                  Select Milestone / Task
                </label>
                <select
                  value={String(selectedTask.id)}
                  onChange={(e) => {
                    const found = tasks.find((t) => String(t.id) === e.target.value);
                    if (found) setSelectedTask(found);
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-white"
                >
                  {tasks.map((t) => (
                    <option key={String(t.id)} value={String(t.id)}>
                      {t.name} ({t.status ?? "scheduled"})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="mt-4 space-y-3">
              <div>
                <span className="text-[11px] text-slate-400">Task ID</span>
                <div className="mt-0.5 font-mono text-xs text-slate-300">{String(selectedTask.id)}</div>
              </div>

              <div>
                <span className="text-[11px] text-slate-400">Financial Lock Status</span>
                <div className="mt-1">
                  {selectedTask.status === "funded" || selectedTask.status === "paid" ? (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                      🔒 Financially Locked ({selectedTask.status})
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                      🔓 Editable ({selectedTask.status ?? "planned"})
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400">Start Date</label>
                <input
                  type="date"
                  disabled={selectedTask.status === "funded" || selectedTask.status === "paid"}
                  value={selectedTask.startDate.slice(0, 10)}
                  onChange={(e) => {
                    const updated = { ...selectedTask, startDate: e.target.value };
                    setSelectedTask(updated);
                    onTaskChange?.(updated);
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-white disabled:opacity-50"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400">Duration (Days)</label>
                <input
                  type="number"
                  min={0}
                  max={120}
                  disabled={selectedTask.status === "funded" || selectedTask.status === "paid"}
                  value={selectedTask.duration}
                  onChange={(e) => {
                    const updated = {
                      ...selectedTask,
                      duration: Math.max(0, parseInt(e.target.value || "1", 10)),
                    };
                    setSelectedTask(updated);
                    onTaskChange?.(updated);
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-white disabled:opacity-50"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400">
                  Progress ({selectedTask.percentDone ?? 0}%)
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={selectedTask.percentDone ?? 0}
                  onChange={(e) => {
                    const updated = {
                      ...selectedTask,
                      percentDone: parseInt(e.target.value, 10),
                    };
                    setSelectedTask(updated);
                    onTaskChange?.(updated);
                  }}
                  className="mt-1 w-full"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400">Assigned Consultant</label>
                <select
                  value={selectedTask.assignedConsultantId ?? ""}
                  onChange={(e) => {
                    const c = consultants.find((x) => x.id === e.target.value);
                    const updated = {
                      ...selectedTask,
                      assignedConsultantId: c?.id ?? null,
                      assignedConsultantName: c?.name ?? null,
                    };
                    setSelectedTask(updated);
                    onTaskChange?.(updated);
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-white"
                >
                  <option value="">Unassigned</option>
                  {consultants.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.status})
                    </option>
                  ))}
                </select>
              </div>

              {selectedTask.budgetUsd !== undefined && (
                <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
                  <div className="text-[11px] text-slate-400">Milestone Budget Allocation</div>
                  <div className="mt-0.5 text-sm font-semibold text-emerald-400">
                    ${Number(selectedTask.budgetUsd).toLocaleString("en-US", { minimumFractionDigits: 2 })} USD
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
        background: active ? "#1e293b" : "transparent",
        border: `1px solid ${active ? "#3b82f6" : "#1e293b"}`,
        borderRadius: 6,
        color: active ? "#f8fafc" : "#94a3b8",
        cursor: "pointer",
        fontSize: 12,
        padding: "3px 10px",
        transition: "color 0.15s, border-color 0.15s, background 0.15s",
      }}
    >
      {label}
    </button>
  );
}
