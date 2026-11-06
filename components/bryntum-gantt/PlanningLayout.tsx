/**
 * PlanningLayout — Client Component (Section 6 Advanced Project Planning)
 *
 * Orchestrates:
 * - Project selector & live synchronization between Neon DB, AG Grid Unscheduled Tasks, and Bryntum Gantt
 * - AI Reschedule & Planning Proposal Trigger + Human Authorization Gate
 * - Optimistic concurrency persistence via `/api/operations/data` and `/api/ai-ops/approve`
 */
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import dynamicImport from "next/dynamic";
import type { BryntumGantt as BryntumGanttClass } from "@bryntum/gantt-react";
import type {
  GanttTask,
  GanttDependency,
  GanttConsultantResource,
  SchedulingProposalPreview,
} from "@/components/bryntum-gantt/BryntumGantt";
import UnscheduledTasksGrid, {
  DEFAULT_UNSCHEDULED_TASKS,
  type UnscheduledTask,
} from "@/components/bryntum-gantt/UnscheduledTasksGrid";

const BryntumGanttDynamic = dynamicImport(
  () => import("@/components/bryntum-gantt/BryntumGantt"),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          background: "#0a0e18",
          color: "#94a3b8",
          fontFamily: "system-ui, sans-serif",
          fontSize: 14,
        }}
      >
        Loading Bryntum Gantt Enterprise Schedule…
      </div>
    ),
  }
);

export interface PlanningProjectOption {
  id: string;
  title: string;
  status: string;
}

export interface PlanningLayoutProps {
  projectId?: string;
  projectOptions?: PlanningProjectOption[];
  initialTasks?: GanttTask[];
  initialDependencies?: GanttDependency[];
  initialConsultants?: GanttConsultantResource[];
  initialProposal?: SchedulingProposalPreview | null;
}

let _dropSeq = 0;
function nextDropId(): string {
  return `dropped-${++_dropSeq}`;
}

export default function PlanningLayout({
  projectId,
  projectOptions = [],
  initialTasks,
  initialDependencies,
  initialConsultants = [],
  initialProposal = null,
}: PlanningLayoutProps) {
  const [unscheduledTasks, setUnscheduledTasks] = useState<UnscheduledTask[]>(
    DEFAULT_UNSCHEDULED_TASKS
  );
  const [activeProposal, setActiveProposal] =
    useState<SchedulingProposalPreview | null>(initialProposal);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [isGeneratingAiProposal, setIsGeneratingAiProposal] = useState(false);

  const ganttRef = useRef<BryntumGanttClass | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  const unscheduledRef = useRef<UnscheduledTask[]>(unscheduledTasks);
  useEffect(() => {
    unscheduledRef.current = unscheduledTasks;
  }, [unscheduledTasks]);

  const addTask = useCallback((taskData: Partial<GanttTask>): boolean => {
    const project = ganttRef.current?.instance?.project;
    if (!project) {
      console.error("[Planning] Cannot schedule task: Bryntum project is not ready.");
      return false;
    }

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

  const scheduleTask = useCallback(
    (taskId: string | number, targetStartDate: string): boolean => {
      const task = unscheduledRef.current.find(
        (candidate) => String(candidate.id) === String(taskId)
      );
      if (!task) {
        return false;
      }

      const inserted = addTask({
        id: task.id,
        name: task.name,
        startDate: targetStartDate,
        duration: Number(task.estimatedDays) || 1,
        percentDone: 0,
      });
      if (inserted) {
        setUnscheduledTasks((current) =>
          current.filter((candidate) => String(candidate.id) !== String(task.id))
        );
        setSyncMessage(`Scheduled '${task.name}' starting ${targetStartDate}`);
      }
      return inserted;
    },
    [addTask]
  );

  // Set up Bryntum DragHelper for AG Grid -> Bryntum Gantt row dragging
  useEffect(() => {
    if (!splitRef.current) return;

    let dragHelper: { destroy(): void } | null = null;
    let disposed = false;

    import("@bryntum/gantt").then(({ DragHelper }) => {
      if (!splitRef.current || disposed) return;

      dragHelper = new DragHelper({
        outerElement: splitRef.current,
        targetSelector: ".ag-row",
        dropTargetSelector: ".gantt-drop-zone, .b-gantt, .b-gridbase",
        cloneTarget: true,
        mode: "translateXY",
        dragThreshold: 5,
        hideOriginalElement: false,

        listeners: {
          drag({
            context,
          }: {
            context: {
              target: HTMLElement | null;
              valid: boolean;
            };
          }) {
            context.valid = Boolean(
              context.target?.closest(".gantt-drop-zone, .b-gantt, .b-gridbase")
            );
          },

          drop({
            context,
          }: {
            context: {
              element: HTMLElement;
              grabbed: HTMLElement;
              target: HTMLElement;
              relatedElements: HTMLElement[];
              valid: boolean;
            };
          }) {
            if (!context.target?.closest(".gantt-drop-zone, .b-gantt, .b-gridbase"))
              return;

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

            if (!task) return;

            const proxyRect = context.element.getBoundingClientRect();
            const dropX = proxyRect.left + proxyRect.width / 2;

            const ganttInstance = ganttRef.current?.instance as
              | {
                  getDateFromCoordinate?: (
                    x: number,
                    roundingMethod?: "floor" | "round" | "ceil",
                    local?: boolean,
                    allowOutOfRange?: boolean
                  ) => Date;
                }
              | undefined;

            const targetDate: Date | null = ganttInstance?.getDateFromCoordinate
              ? ganttInstance.getDateFromCoordinate(dropX, "floor", false, true)
              : null;

            const startDate = targetDate
              ? targetDate.toISOString().slice(0, 10)
              : new Date().toISOString().slice(0, 10);

            scheduleTask(task.id, startDate);
          },
        },
      });
    });

    return () => {
      disposed = true;
      dragHelper?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleExternalDrop = useCallback((payload: unknown, date: Date) => {
    console.debug("[Gantt] external drop:", payload, "at", date);
  }, []);

  // AI Copilot handler — receives validated SchedulingProposal from Planning/Reschedule Agent
  const handleAiMessage = useCallback(
    async (message: string): Promise<string> => {
      const response = await fetch("/api/ai/planning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          projectId,
          availableTasks: unscheduledRef.current.map(({ id, name }) => ({
            id,
            name,
          })),
        }),
      });
      const result = (await response.json()) as {
        text?: string;
        error?: string;
        schedulingProposal?: SchedulingProposalPreview | null;
        toolCalls?: Array<{
          toolName: string;
          input: { taskId: string | number; targetStartDate: string };
        }>;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "The planning AI request failed.");
      }

      if (result.schedulingProposal) {
        setActiveProposal(result.schedulingProposal);
      }

      const scheduled: string[] = [];
      for (const call of result.toolCalls ?? []) {
        if (call.toolName !== "scheduleTask") continue;
        if (scheduleTask(call.input.taskId, call.input.targetStartDate)) {
          scheduled.push(
            `Scheduled backlog task \`${call.input.taskId}\` for ${call.input.targetStartDate}.`
          );
        }
      }
      return (
        [result.text, ...scheduled].filter(Boolean).join("\n\n") ||
        "Prepared scheduling assessment."
      );
    },
    [projectId, scheduleTask]
  );

  // Trigger Reschedule Agent directly from top bar
  const handleTriggerRescheduleProposal = async () => {
    setIsGeneratingAiProposal(true);
    setSyncMessage("Running Reschedule Agent critical-path analysis…");
    try {
      const res = await fetch("/api/ai-ops/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_request:
            "Analyze project schedule dependencies and propose a +3 day Finish-to-Start reschedule for unlocked milestones",
          operation_type: "schedule_reschedule",
          project_id: projectId,
          context: { delay_days: 3 },
        }),
      });
      const data = await res.json();
      if (res.ok && data.scheduling_proposals?.[0]) {
        setActiveProposal(data.scheduling_proposals[0]);
        setSyncMessage(
          `Proposal ${data.scheduling_proposals[0].proposal_id} ready for human authorization.`
        );
      } else {
        setSyncMessage(data.error ?? "Completed schedule analysis.");
      }
    } catch (err) {
      setSyncMessage(
        err instanceof Error ? err.message : "Failed to run Reschedule Agent."
      );
    } finally {
      setIsGeneratingAiProposal(false);
    }
  };

  // Authorize & apply scheduling proposal via /api/ai-ops/approve
  const handleApproveProposal = useCallback(
    async (proposal: SchedulingProposalPreview) => {
      const res = await fetch("/api/ai-ops/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposal_id: proposal.proposal_id,
          execution_id: proposal.execution_id,
          decision: "approved",
          actor_id: "company-schedule-approver",
          actor_role: "company",
          reason: "Authorized schedule adjustments from Bryntum Gantt Planning console",
        }),
      });
      if (res.ok) {
        setActiveProposal((prev) =>
          prev ? { ...prev, status: "approved" } : null
        );
        setSyncMessage(
          `✓ Authorized proposal ${proposal.proposal_id} and synchronized ${proposal.adjustments.length} milestone(s) in Neon DB.`
        );
      }
    },
    []
  );

  const handleRejectProposal = useCallback(
    async (proposal: SchedulingProposalPreview) => {
      const res = await fetch("/api/ai-ops/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposal_id: proposal.proposal_id,
          execution_id: proposal.execution_id,
          decision: "rejected",
          actor_id: "company-schedule-approver",
          actor_role: "company",
          reason: "Rejected proposed schedule shift in Planning console",
        }),
      });
      if (res.ok) {
        setActiveProposal(null);
        setSyncMessage(`Rejected scheduling proposal ${proposal.proposal_id}.`);
      }
    },
    []
  );

  // Persist task modifications back to Neon DB so Bryntum and AG Grid remain in sync
  const handleTaskChange = useCallback(async (task: GanttTask) => {
    const idStr = String(task.id);
    if (idStr.startsWith("seed-") || idStr.startsWith("dropped-") || idStr.startsWith("u-")) {
      return;
    }
    try {
      const startIso =
        typeof task.startDate === "string"
          ? task.startDate.slice(0, 10)
          : new Date(task.startDate as unknown as string).toISOString().slice(0, 10);
      const dur = Number(task.duration) || 1;
      const startDt = new Date(`${startIso}T00:00:00Z`);
      startDt.setUTCDate(startDt.getUTCDate() + dur);
      const dueIso = startDt.toISOString().slice(0, 10);

      const res = await fetch("/api/operations/data", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "task",
          id: idStr,
          updates: {
            title: task.name,
            startDate: startIso,
            dueDate: dueIso,
          },
        }),
      });
      if (res.ok) {
        setSyncMessage(`Synchronized '${task.name}' (${startIso} → ${dueIso}) to Neon DB`);
      }
    } catch {
      // Non-fatal UI sync
    }
  }, []);

  return (
    <div className="flex min-h-[calc(100vh-80px)] min-w-0 w-full flex-col overflow-hidden bg-slate-950 p-3 gap-3">
      {/* ── Project Header & Multi-Agent Reschedule Bar ─────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 px-4 py-2.5 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-white">Active Project Plan:</span>
          {projectOptions.length > 0 ? (
            <select
              value={projectId ?? projectOptions[0]?.id}
              onChange={(e) => {
                window.location.href = `/planning?projectId=${encodeURIComponent(e.target.value)}`;
              }}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-100"
            >
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.status})
                </option>
              ))}
            </select>
          ) : (
            <span className="text-slate-400">Default Enterprise Schedule</span>
          )}
          {syncMessage && (
            <span className="rounded bg-slate-800 px-2.5 py-1 text-[11px] text-emerald-400">
              {syncMessage}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isGeneratingAiProposal}
            onClick={handleTriggerRescheduleProposal}
            className="rounded-lg border border-blue-500/40 bg-blue-500/15 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-500/25 disabled:opacity-50"
          >
            {isGeneratingAiProposal
              ? "Running Reschedule Agent…"
              : "✦ Generate AI Reschedule Proposal"}
          </button>
          <a
            href="/operations?tab=tasks"
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            ⊞ Open in AG Grid Operations
          </a>
        </div>
      </div>

      {/* ── Split-Screen Backlog AG Grid + Bryntum Gantt ────────────────────── */}
      <div
        ref={splitRef}
        className="flex min-h-0 min-w-0 flex-1 flex-row gap-3 overflow-hidden"
      >
        <div className="flex w-80 shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/50">
          <UnscheduledTasksGrid tasks={unscheduledTasks} />
        </div>

        <div className="gantt-drop-zone flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/50">
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <BryntumGanttDynamic
              tasks={initialTasks && initialTasks.length > 0 ? initialTasks : undefined}
              dependencies={
                initialDependencies && initialDependencies.length > 0
                  ? initialDependencies
                  : undefined
              }
              consultants={initialConsultants}
              activeProposal={activeProposal}
              onApproveProposal={handleApproveProposal}
              onRejectProposal={handleRejectProposal}
              onTaskChange={handleTaskChange}
              onExternalDrop={handleExternalDrop}
              onAiMessage={handleAiMessage}
              ganttRef={ganttRef}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
