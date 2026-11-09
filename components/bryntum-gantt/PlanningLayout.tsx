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
import { useRouter } from "next/navigation";
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
import { isTempTaskId } from "@/lib/gantt/bryntum-config";

const BryntumGanttDynamic = dynamicImport(
  () => import("@/components/bryntum-gantt/BryntumGantt"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full flex-col justify-between bg-[#0b0f17] p-5 text-xs text-slate-300">
        <div className="space-y-2">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <span className="font-semibold text-white">Bryntum Gantt Critical-Path Engine</span>
            <span className="font-mono text-[11px] text-blue-400">Initializing WBS timeline…</span>
          </div>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4 py-2 border-b border-slate-800/50">
              <div className="h-4 w-44 rounded bg-slate-800/80 skeleton-shimmer" />
              <div className="h-4 flex-1 rounded bg-slate-800/50 skeleton-shimmer" />
            </div>
          ))}
        </div>
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
  /** Server load failure — surfaces an honest error panel in the Gantt. */
  loadError?: string | null;
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
  loadError = null,
}: PlanningLayoutProps) {
  const router = useRouter();
  const [unscheduledTasks, setUnscheduledTasks] = useState<UnscheduledTask[]>(
    DEFAULT_UNSCHEDULED_TASKS
  );
  const [activeProposal, setActiveProposal] =
    useState<SchedulingProposalPreview | null>(initialProposal);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncIsError, setSyncIsError] = useState(false);
  const [isGeneratingAiProposal, setIsGeneratingAiProposal] = useState(false);
  // Client-side overlays merged over server props (no prop→state sync effects):
  // optimistic drops, temp→server id remaps, field patches, and dep edits.
  // Entries self-clean once router.refresh() delivers them in fresh props.
  const [addedTasks, setAddedTasks] = useState<GanttTask[]>([]);
  const [taskRemaps, setTaskRemaps] = useState<Record<string, { id: string; version: number }>>({});
  const [taskPatches, setTaskPatches] = useState<Record<string, Partial<GanttTask>>>({});
  const [depAdded, setDepAdded] = useState<GanttDependency[]>([]);
  const [depRemovedIds, setDepRemovedIds] = useState<Record<string, true>>({});

  const ganttRef = useRef<BryntumGanttClass | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  const unscheduledRef = useRef<UnscheduledTask[]>(unscheduledTasks);
  useEffect(() => {
    unscheduledRef.current = unscheduledTasks;
  }, [unscheduledTasks]);

  const setSync = useCallback((message: string, isError = false) => {
    setSyncMessage(message);
    setSyncIsError(isError);
  }, []);

  /** Reconcile a temp store id with the server-persisted milestone id. */
  const remapStoreId = useCallback(
    (tempId: string | number, serverId: string, serverVersion: number) => {
      const store = ganttRef.current?.instance?.project?.taskStore as
        | {
            getById?: (id: string | number) => { set?: (k: string, v: unknown) => void } | null;
          }
        | undefined;
      const record = store?.getById?.(tempId);
      record?.set?.("id", serverId);
      setTaskRemaps((prev) => ({
        ...prev,
        [String(tempId)]: { id: serverId, version: serverVersion },
      }));
    },
    []
  );

  const removeStoreTask = useCallback((tempId: string | number) => {
    const store = ganttRef.current?.instance?.project?.taskStore as
      | {
          getById?: (id: string | number) => unknown | null;
          remove?: (record: unknown) => void;
        }
      | undefined;
    const record = store?.getById?.(tempId);
    if (record) store?.remove?.(record);
    setAddedTasks((prev) => prev.filter((t) => String(t.id) !== String(tempId)));
  }, []);

  // Merged task list: server props + patches + optimistic adds (deduped).
  const localTasks = React.useMemo(() => {
    const base = (initialTasks ?? []).map((t) => {
      const patch = taskPatches[String(t.id)];
      return patch ? { ...t, ...patch } : t;
    });
    const baseIds = new Set(base.map((t) => String(t.id)));
    const added = addedTasks
      .map((t) => {
        const remap = taskRemaps[String(t.id)];
        return remap ? { ...t, id: remap.id, version: remap.version } : t;
      })
      .filter((t) => !baseIds.has(String(t.id)));
    if (initialTasks === undefined && added.length === 0) return undefined;
    return [...base, ...added];
  }, [initialTasks, addedTasks, taskRemaps, taskPatches]);

  // Merged dependency list: server props − removals + optimistic adds (deduped by pair).
  const localDependencies = React.useMemo(() => {
    const base = (initialDependencies ?? []).filter((d) => !depRemovedIds[String(d.id)]);
    const basePairs = new Set(base.map((d) => `${String(d.fromTask)}→${String(d.toTask)}`));
    const added = depAdded.filter(
      (d) =>
        !depRemovedIds[String(d.id)] &&
        !basePairs.has(`${String(d.fromTask)}→${String(d.toTask)}`)
    );
    if (initialDependencies === undefined && added.length === 0) return undefined;
    return [...base, ...added];
  }, [initialDependencies, depAdded, depRemovedIds]);

  const addTask = useCallback(
    (taskData: Partial<GanttTask>): boolean => {
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
      setAddedTasks((prev) =>
        prev.some((t) => String(t.id) === String(normalizedTask.id))
          ? prev
          : [...prev, normalizedTask]
      );

      // Persist temp-id drops to the DB; reconcile the store id on success,
      // roll back the inserted record on failure. No id is silently skipped.
      if (isTempTaskId(normalizedTask.id) && projectId) {
        const tempId = normalizedTask.id;
        void (async () => {
          try {
            const res = await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/milestones`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  title: normalizedTask.name,
                  startDate: normalizedTask.startDate.slice(0, 10),
                  durationDays: normalizedTask.duration,
                }),
              }
            );
            const data = (await res.json()) as {
              milestone?: { id: string; version: number };
              error?: string;
            };
            if (!res.ok || !data.milestone) {
              removeStoreTask(tempId);
              setSync(
                `Drop failed for '${normalizedTask.name}': ${data.error ?? `HTTP ${res.status}`} — rolled back.`,
                true
              );
              return;
            }
            remapStoreId(tempId, data.milestone.id, data.milestone.version);
            setSync(
              `Scheduled '${normalizedTask.name}' starting ${normalizedTask.startDate.slice(0, 10)} (v${data.milestone.version})`
            );
            router.refresh();
          } catch (err) {
            removeStoreTask(tempId);
            setSync(
              `Drop failed for '${normalizedTask.name}': ${err instanceof Error ? err.message : "network error"} — rolled back.`,
              true
            );
          }
        })();
      }
      return true;
    },
    [projectId, remapStoreId, removeStoreTask, router, setSync]
  );

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
        setSync(`Scheduled '${task.name}' starting ${targetStartDate}`);
      }
      return inserted;
    },
    [addTask, setSync]
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

  const handleExternalDrop = useCallback(
    (payload: unknown, date: Date) => {
      const data = (payload ?? {}) as Record<string, unknown>;
      const rawId = data.id ?? data.taskId;
      const startDate = Number.isNaN(date.getTime())
        ? new Date().toISOString().slice(0, 10)
        : date.toISOString().slice(0, 10);
      // Known backlog row → full schedule flow (persist + remove from backlog).
      if (rawId !== undefined && rawId !== null) {
        const known = unscheduledRef.current.find(
          (t) => String(t.id) === String(rawId)
        );
        if (known) {
          scheduleTask(known.id, startDate);
          return;
        }
      }
      // Ad-hoc payload → insert + persist via addTask (temp id reconciled).
      const name =
        typeof data.name === "string" && data.name.trim().length > 0
          ? data.name.trim()
          : typeof data.title === "string" && data.title.trim().length > 0
            ? data.title.trim()
            : "Dropped task";
      const duration =
        (typeof data.estimatedDays === "number" && data.estimatedDays > 0
          ? data.estimatedDays
          : typeof data.duration === "number" && data.duration > 0
            ? data.duration
            : 1);
      addTask({ name, startDate, duration });
    },
    [addTask, scheduleTask]
  );

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
    setSync("Running Reschedule Agent critical-path analysis…");
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
        setSync(
          `Proposal ${data.scheduling_proposals[0].proposal_id} ready for human authorization.`
        );
      } else {
        setSync(data.error ?? "Completed schedule analysis.", !res.ok);
      }
    } catch (err) {
      setSync(
        err instanceof Error ? err.message : "Failed to run Reschedule Agent.",
        true
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
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setActiveProposal((prev) =>
          prev ? { ...prev, status: "approved" } : null
        );
        setSync(
          `✓ Authorized proposal ${proposal.proposal_id} and synchronized ${proposal.adjustments.length} milestone(s) in Neon DB.`
        );
        router.refresh();
      } else {
        setSync(`Approve failed: ${data.error ?? `HTTP ${res.status}`}`, true);
      }
    },
    [router, setSync]
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
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setActiveProposal(null);
        setSync(`Rejected scheduling proposal ${proposal.proposal_id}.`);
        router.refresh();
      } else {
        setSync(`Reject failed: ${data.error ?? `HTTP ${res.status}`}`, true);
      }
    },
    [router, setSync]
  );

  // Persist task modifications back to the DB so Bryntum and AG Grid stay in sync.
  // Temp ids are routed to the create endpoint (then reconciled); nothing is skipped.
  const handleTaskChange = useCallback(
    async (task: GanttTask) => {
      const idStr = String(task.id);
      if (!projectId) return;
      const startIso =
        typeof task.startDate === "string"
          ? task.startDate.slice(0, 10)
          : new Date(task.startDate as unknown as string).toISOString().slice(0, 10);
      try {
        if (isTempTaskId(idStr)) {
          const res = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}/milestones`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: task.name,
                startDate: startIso,
                durationDays: Number(task.duration) || 1,
              }),
            }
          );
          const data = (await res.json()) as {
            milestone?: { id: string; version: number };
            error?: string;
          };
          if (!res.ok || !data.milestone) {
            setSync(
              `Persist failed for '${task.name}': ${data.error ?? `HTTP ${res.status}`}`,
              true
            );
            return;
          }
          remapStoreId(idStr, data.milestone.id, data.milestone.version);
          setSync(`Synchronized '${task.name}' to the database (v${data.milestone.version})`);
          router.refresh();
          return;
        }

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
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.ok) {
          setTaskPatches((prev) => ({
            ...prev,
            [idStr]: { name: task.name, startDate: startIso, duration: dur },
          }));
          setSync(`Synchronized '${task.name}' (${startIso} → ${dueIso}) to Neon DB`);
          router.refresh();
        } else {
          setSync(
            `Sync failed for '${task.name}': ${data.error ?? `HTTP ${res.status}`}`,
            true
          );
        }
      } catch (err) {
        setSync(
          `Sync failed for '${task.name}': ${err instanceof Error ? err.message : "network error"}`,
          true
        );
      }
    },
    [projectId, remapStoreId, router, setSync]
  );

  // Persist dependency edits (link/unlink in the Gantt) via the dependencies API.
  const handleDependencyChange = useCallback(
    async (op: "add" | "update" | "remove", dep: GanttDependency) => {
      if (!projectId) return;
      const fromId = String(dep.fromTask);
      const toId = String(dep.toTask);
      if (isTempTaskId(fromId) || isTempTaskId(toId)) {
        setSync("Save both tasks before linking them with a dependency.", true);
        return;
      }
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/milestones/dependencies`,
          {
            method: op === "remove" ? "DELETE" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              op === "remove"
                ? { milestoneId: toId }
                : {
                    milestoneId: toId,
                    dependsOnId: fromId,
                    offsetDays: typeof dep.lag === "number" && dep.lag > 0 ? Math.round(dep.lag) : 1,
                  }
            ),
          }
        );
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          recalc?: { updated?: unknown[]; warnings?: string[] };
        };
        if (!res.ok) {
          // Roll back the optimistic Bryntum dependency-store change.
          const depStore = ganttRef.current?.instance?.project?.dependencyStore as
            | {
                getById?: (id: string | number) => unknown | null;
                remove?: (record: unknown) => void;
                add?: (record: unknown) => void;
              }
            | undefined;
          const record = depStore?.getById?.(dep.id);
          if (op === "remove") {
            if (!record) depStore?.add?.(dep);
          } else if (record) {
            depStore?.remove?.(record);
          }
          setSync(`Dependency ${op} failed: ${data.error ?? `HTTP ${res.status}`}`, true);
          return;
        }
        if (op === "remove") {
          setDepRemovedIds((prev) => ({ ...prev, [String(dep.id)]: true }));
          setDepAdded((prev) => prev.filter((d) => String(d.id) !== String(dep.id)));
        } else {
          setDepAdded((prev) => [
            ...prev.filter((d) => String(d.id) !== String(dep.id)),
            dep,
          ]);
        }
        const warnings = data.recalc?.warnings;
        setSync(
          op === "remove"
            ? `Removed dependency link to '${toId}'.`
            : `Saved dependency: '${fromId}' → '${toId}'${warnings?.length ? ` (${warnings.length} recalc warning(s))` : ""}`
        );
        router.refresh();
      } catch (err) {
        setSync(
          `Dependency ${op} failed: ${err instanceof Error ? err.message : "network error"}`,
          true
        );
      }
    },
    [projectId, router, setSync]
  );

  const totalScheduledBudget = (localTasks ?? initialTasks ?? []).reduce(
    (sum, t) => sum + (Number(t.budgetUsd) || 0),
    0
  );

  return (
    <div className="flex min-h-[calc(100vh-80px)] min-w-0 w-full flex-col overflow-hidden bg-[#090c12] p-3 sm:p-4 gap-3">
      {/* ── Project Header & Multi-Agent Reschedule Bar ─────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#0f141e] px-4 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-blue-600/20 border border-blue-500/30 text-blue-400 font-mono text-xs">
              ◈
            </span>
            <h1 className="text-sm font-bold text-white">Bryntum Gantt Critical-Path Schedule</h1>
          </div>

          <div className="h-4 w-px bg-slate-800 hidden sm:block" />

          {projectOptions.length > 0 ? (
            <select
              aria-label="Select project schedule"
              value={projectId ?? projectOptions[0]?.id}
              onChange={(e) => {
                router.push(`/planning?projectId=${encodeURIComponent(e.target.value)}`);
              }}
              className="rounded-lg border border-slate-700/80 bg-[#0b0f17] px-3 py-1.5 text-xs font-medium text-slate-100 focus:border-blue-500 focus:outline-none"
            >
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.status})
                </option>
              ))}
            </select>
          ) : (
            <span className="text-slate-300">Default Enterprise Schedule</span>
          )}

          <div className="hidden xl:flex items-center gap-3 border-l border-slate-800 pl-3 text-[11px] text-slate-300">
            <span>
              <strong className="font-mono font-semibold tabular-nums text-white">
                {(localTasks ?? initialTasks)?.length ?? 0}
              </strong>{" "}
              WBS tasks
            </span>
            <span>
              <strong className="font-mono font-semibold tabular-nums text-blue-400">
                {(localDependencies ?? initialDependencies)?.length ?? 0}
              </strong>{" "}
              FS dependencies
            </span>
            {totalScheduledBudget > 0 && (
              <span>
                <strong className="font-mono font-semibold tabular-nums text-emerald-400">
                  ${totalScheduledBudget.toLocaleString()}
                </strong>{" "}
                budget
              </span>
            )}
          </div>

          {syncMessage && (
            <span
              className={
                syncIsError
                  ? "rounded-md border border-rose-500/30 bg-rose-950/40 px-2.5 py-1 text-[11px] font-medium text-rose-300"
                  : "rounded-md border border-emerald-500/30 bg-emerald-950/40 px-2.5 py-1 text-[11px] font-medium text-emerald-300"
              }
            >
              {syncMessage}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
            className="rounded-lg border border-slate-700/80 bg-[#0b0f17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
          >
            ⊞ Open in AG Grid Operations
          </a>
        </div>
      </div>

      {/* ── Split-Screen Backlog AG Grid + Bryntum Gantt ────────────────────── */}
      <div
        ref={splitRef}
        className="flex min-h-[540px] min-w-0 flex-1 flex-col lg:flex-row gap-3 overflow-hidden"
      >
        <div className="flex w-full lg:w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-[#0f141e] shadow-lg max-h-64 lg:max-h-none">
          <UnscheduledTasksGrid tasks={unscheduledTasks} />
        </div>

        <div className="gantt-drop-zone flex min-h-[460px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-[#0f141e] shadow-lg">
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <BryntumGanttDynamic
              tasks={localTasks}
              dependencies={localDependencies}
              consultants={initialConsultants}
              activeProposal={activeProposal}
              onApproveProposal={handleApproveProposal}
              onRejectProposal={handleRejectProposal}
              onTaskChange={handleTaskChange}
              onDependencyChange={handleDependencyChange}
              onExternalDrop={handleExternalDrop}
              onAiMessage={handleAiMessage}
              ganttRef={ganttRef}
              loadError={loadError}
              isEmpty={!loadError && localTasks !== undefined && localTasks.length === 0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
