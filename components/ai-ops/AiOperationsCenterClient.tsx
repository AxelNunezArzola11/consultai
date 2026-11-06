"use client";

/**
 * AiOperationsCenterClient — Section 8 Dedicated AI Operations Center
 *
 * Displays:
 * - Real-time Agent Availability & Telemetry (Supervisor, Planning, Talent, Delivery, Finance, Reschedule)
 * - Live SSE Streaming Connection (`/api/sse/ai-ops`)
 * - Interactive Multi-Agent Supervisor Command Console
 * - Delegation Relationships & Workflow Architecture Visualizer
 * - Pending Human Approvals Queue (Financial Proposals & Scheduling Proposals)
 * - Execution History Table with Token Consumption, Duration, and Retry Info
 * - Execution Detail View (User Request, Supervisor Decision, Delegated Agents,
 *   Structured Agent Outputs, Tool Calls, Execution Status, Approval Status, Final Result)
 *   Strictly shows operational events and decisions without exposing private model chain-of-thought.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

export interface AgentStatusMetric {
  agent_id: string;
  display_name: string;
  role_description: string;
  status: "ready" | "busy" | "degraded";
  llm_configured: boolean;
  model_name: string;
  active_executions: number;
  total_executions: number;
  successful_executions: number;
  failed_executions: number;
  total_tokens_consumed: number;
  avg_duration_ms: number;
  last_active_at: string | null;
}

export interface ExecutionRecord {
  execution_id: string;
  project_id: string | null;
  user_request: string;
  intent: string;
  supervisor_decision: {
    intent?: string;
    selected_agents?: string[];
    requires_human_approval?: boolean;
    decision_rationale?: string;
  };
  delegated_agents: string[];
  handoffs: Array<{
    handoff_id: string;
    from_agent: string;
    to_agent: string;
    reason: string;
    context_keys: string[];
    status: string;
    duration_ms: number;
    timestamp: string;
  }>;
  status: string;
  approval_status: string;
  structured_outputs: Record<string, unknown>;
  tool_calls: Array<{
    tool_name: string;
    agent_name: string;
    inputs_summary: Record<string, unknown>;
    output_summary: string;
    status: string;
    duration_ms: number;
    timestamp: string;
  }>;
  errors: Array<{
    error_code: string;
    agent_name: string;
    message: string;
    recoverable: boolean;
    retry_attempt: number;
    timestamp: string;
  }>;
  retry_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  final_result: string;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface SchedulingProposalRecord {
  proposal_id: string;
  project_id: string;
  execution_id: string | null;
  proposed_by_agent: string;
  overall_risk: string;
  total_delay_days: number;
  rationale: string;
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
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface PaymentProposalRecord {
  proposal_id: string;
  milestone_id: string;
  run_id: string;
  bound_head_sha: string;
  amount_usd: string;
  policy_decision: string;
  justification: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface AiOpsSnapshot {
  agents: AgentStatusMetric[];
  executions: ExecutionRecord[];
  scheduling_proposals: SchedulingProposalRecord[];
  payment_proposals: PaymentProposalRecord[];
  pending_payment_approvals: Array<{
    approval_id: string;
    payment_id: string;
    milestone_id: string;
    requested_by: string;
    decision: string;
    created_at: string;
  }>;
  verification_runs: Array<{
    id: string;
    milestone_id: string;
    pr_url: string;
    pr_owner: string;
    pr_repo: string;
    pr_number: number;
    head_sha: string | null;
    policy_decision: string | null;
    duration_ms: number | null;
    status: string;
    created_at: string;
  }>;
  recent_audits: Array<{
    id: string;
    entity_type: string;
    entity_id: string;
    event: string;
    actor: string;
    payload: unknown;
    created_at: string;
  }>;
}

const PRESET_PROMPTS: Array<{ label: string; opType: string; prompt: string }> = [
  {
    label: "◈ Generate Project WBS & Critical Path",
    opType: "project_planning",
    prompt:
      "Generate a comprehensive Work Breakdown Structure, identify critical path dependencies, and propose a Bryntum Gantt baseline schedule.",
  },
  {
    label: "⏱ Analyze +4 Day Delay Cascade",
    opType: "schedule_reschedule",
    prompt:
      "Analyze a 4-day upstream deliverable delay, propagate Finish-to-Start shifts across unlocked milestones, and generate a validated reschedule proposal.",
  },
  {
    label: "👤 Evaluate Consultant Talent & GitHub Signals",
    opType: "talent_evaluation",
    prompt:
      "Evaluate project consultant candidates, analyze verified GitHub repository signals against technical requirements, and rank top recommendations.",
  },
  {
    label: "✓ Verify Deliverable & Prepare Finance Proposal",
    opType: "delivery_verification",
    prompt:
      "Verify milestone deliverable acceptance criteria and prepare a Stage 1 & 2 financial payout proposal requiring human authorization.",
  },
  {
    label: "★ Full Multi-Agent Project Audit",
    opType: "full_project_review",
    prompt:
      "Execute a coordinated multi-agent audit across Planning, Talent, Reschedule, and Finance agents for the active project.",
  },
];

export default function AiOperationsCenterClient({
  initialSnapshot,
  initialSelectedExecutionId,
  projectsList = [],
}: {
  initialSnapshot: AiOpsSnapshot;
  initialSelectedExecutionId?: string;
  projectsList?: Array<{ id: string; title: string }>;
}) {
  const [snapshot, setSnapshot] = useState<AiOpsSnapshot>(initialSnapshot);
  const [sseConnected, setSseConnected] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString());

  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    projectsList[0]?.id ?? ""
  );
  const [commandInput, setCommandInput] = useState<string>("");
  const [operationType, setOperationType] = useState<string>("auto");
  const [isRunningWorkflow, setIsRunningWorkflow] = useState<boolean>(false);
  const [actionBanner, setActionBanner] = useState<string | null>(null);

  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    initialSelectedExecutionId ?? initialSnapshot.executions[0]?.execution_id ?? null
  );

  // Connect to live Server-Sent Events (/api/sse/ai-ops)
  useEffect(() => {
    const url = selectedProjectId
      ? `/api/sse/ai-ops?projectId=${encodeURIComponent(selectedProjectId)}`
      : "/api/sse/ai-ops";
    const es = new EventSource(url);

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.addEventListener("snapshot", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as AiOpsSnapshot & { timestamp?: string };
        setSnapshot(data);
        setSseConnected(true);
        if (data.timestamp) setLastUpdated(data.timestamp);
      } catch {
        // Ignore malformed event
      }
    });

    return () => {
      es.close();
    };
  }, [selectedProjectId]);

  const selectedExecution = useMemo(() => {
    if (!selectedExecutionId) return snapshot.executions[0] ?? null;
    return (
      snapshot.executions.find((e) => e.execution_id === selectedExecutionId) ??
      snapshot.executions[0] ??
      null
    );
  }, [snapshot.executions, selectedExecutionId]);

  const handleRunSupervisor = useCallback(
    async (overridePrompt?: string, overrideOpType?: string) => {
      const text = (overridePrompt ?? commandInput).trim();
      if (!text || isRunningWorkflow) return;

      setIsRunningWorkflow(true);
      setActionBanner("Supervisor Agent classifying request & delegating to specialists…");
      try {
        const res = await fetch("/api/ai-ops/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_request: text,
            operation_type: overrideOpType ?? operationType,
            project_id: selectedProjectId || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ?? "Supervisor workflow execution failed.");
        }
        setCommandInput("");
        setSelectedExecutionId(data.execution_id);
        setActionBanner(
          `✓ Execution ${data.execution_id} (${data.status}) — Delegated: ${(
            data.delegated_agents ?? []
          ).join(" → ")}`
        );

        // Immediately refresh snapshot
        const snapRes = await fetch("/api/ai-ops/executions", { cache: "no-store" });
        if (snapRes.ok) {
          const snapData = (await snapRes.json()) as AiOpsSnapshot;
          setSnapshot(snapData);
        }
      } catch (err) {
        setActionBanner(
          `⚠ Error: ${err instanceof Error ? err.message : "Execution failed"}`
        );
      } finally {
        setIsRunningWorkflow(false);
      }
    },
    [commandInput, isRunningWorkflow, operationType, selectedProjectId]
  );

  const handleApprovalDecision = useCallback(
    async (params: {
      executionId?: string | null;
      proposalId?: string;
      decision: "approved" | "rejected";
    }) => {
      setActionBanner(`Recording human ${params.decision} decision…`);
      try {
        const res = await fetch("/api/ai-ops/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            execution_id: params.executionId,
            proposal_id: params.proposalId,
            decision: params.decision,
            actor_id: "company-executive-approver",
            actor_role: "company",
            reason: `Human operator ${params.decision} proposal in AI Operations Center`,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to record decision.");
        }
        setActionBanner(
          `✓ Human authorization '${params.decision}' committed (${
            data.applied_schedule_adjustments ?? 0
          } schedule adjustments applied).`
        );

        const snapRes = await fetch("/api/ai-ops/executions", { cache: "no-store" });
        if (snapRes.ok) {
          const snapData = (await snapRes.json()) as AiOpsSnapshot;
          setSnapshot(snapData);
        }
      } catch (err) {
        setActionBanner(
          `⚠ Authorization Error: ${err instanceof Error ? err.message : "Failed"}`
        );
      }
    },
    []
  );

  // Aggregate operational KPIs
  const totalTokensAllRuns = useMemo(
    () => snapshot.executions.reduce((s, e) => s + (e.total_tokens || 0), 0),
    [snapshot.executions]
  );
  const pendingSchedProposals = useMemo(
    () =>
      snapshot.scheduling_proposals.filter((sp) => sp.status === "pending_approval"),
    [snapshot.scheduling_proposals]
  );
  const pendingExecApprovals = useMemo(
    () => snapshot.executions.filter((e) => e.approval_status === "pending"),
    [snapshot.executions]
  );

  return (
    <div className="flex min-h-[calc(100vh-80px)] flex-col gap-5 bg-slate-950 p-5 text-slate-100">
      {/* ── Top Header & Live SSE Status ────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/90 px-6 py-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="rounded bg-blue-500/20 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-blue-400">
              PydanticAI Multi-Agent Orchestration
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                sseConnected
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  sseConnected ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
                }`}
              />
              {sseConnected ? "SSE Live Stream Active" : "Reconnecting Stream…"}
            </span>
          </div>
          <h1 className="mt-1 text-xl font-bold text-white">
            AI Operations Center & Supervisor Command Console
          </h1>
          <p className="text-xs text-slate-400">
            Real-time multi-agent delegation, deterministic policy gates, token telemetry, and human-in-the-loop approvals.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2">
            <div className="text-[10px] uppercase text-slate-500">Total Executions</div>
            <div className="font-mono text-base font-bold text-white">
              {snapshot.executions.length + snapshot.verification_runs.length}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2">
            <div className="text-[10px] uppercase text-slate-500">Pending Approvals</div>
            <div className="font-mono text-base font-bold text-amber-400">
              {pendingExecApprovals.length +
                pendingSchedProposals.length +
                snapshot.pending_payment_approvals.length}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2">
            <div className="text-[10px] uppercase text-slate-500">Total Tokens</div>
            <div className="font-mono text-base font-bold text-blue-400">
              {totalTokensAllRuns.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {actionBanner && (
        <div className="flex items-center justify-between rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-xs text-blue-200">
          <span>{actionBanner}</span>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="text-slate-400 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Section 1: Agent Availability & Roster Telemetry Cards ─────────── */}
      <div>
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">
            1. Multi-Agent Availability & Runtime Telemetry
          </h2>
          <span className="text-[11px] text-slate-500">
            Last stream sync: {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {snapshot.agents.map((ag) => (
            <div
              key={ag.agent_id}
              className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-blue-400">
                    {ag.agent_id}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      ag.status === "busy"
                        ? "bg-blue-500/20 text-blue-300"
                        : "bg-emerald-500/15 text-emerald-400"
                    }`}
                  >
                    {ag.status}
                  </span>
                </div>
                <div className="mt-1 text-sm font-bold text-white">
                  {ag.display_name}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  {ag.role_description}
                </p>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-1 border-t border-slate-800/80 pt-2.5 text-center font-mono text-[11px]">
                <div>
                  <div className="text-[9px] uppercase text-slate-500">Runs</div>
                  <div className="font-semibold text-slate-200">
                    {ag.total_executions}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-slate-500">Avg ms</div>
                  <div className="font-semibold text-slate-200">
                    {ag.avg_duration_ms}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-slate-500">Errors</div>
                  <div
                    className={`font-semibold ${
                      ag.failed_executions > 0 ? "text-rose-400" : "text-emerald-400"
                    }`}
                  >
                    {ag.failed_executions}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Section 2: Interactive Supervisor Command Console ───────────────── */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-white">
              2. Central Supervisor Agent — Dispatch Multi-Agent Workflow
            </h2>
            <p className="text-xs text-slate-400">
              Submit a natural-language instruction or select an operational workflow preset. The Supervisor classifies intent, delegates to specialist agents, validates policy rules, and halts at human approval gates for sensitive actions.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            {projectsList.length > 0 && (
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100"
              >
                {projectsList.map((p) => (
                  <option key={p.id} value={p.id}>
                    Project: {p.title}
                  </option>
                ))}
              </select>
            )}
            <select
              value={operationType}
              onChange={(e) => setOperationType(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100"
            >
              <option value="auto">Auto-Classify (Supervisor)</option>
              <option value="project_planning">Planning Agent (WBS & Gantt)</option>
              <option value="schedule_reschedule">Reschedule Agent (Delay Cascade)</option>
              <option value="talent_evaluation">Talent Agent (GitHub Vetting)</option>
              <option value="delivery_verification">Delivery + Finance Agents</option>
              <option value="financial_assessment">Finance Agent (Payout Proposal)</option>
              <option value="full_project_review">Full Multi-Agent Review</option>
            </select>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {PRESET_PROMPTS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={isRunningWorkflow}
              onClick={() => void handleRunSupervisor(preset.prompt, preset.opType)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-blue-500/50 hover:bg-blue-500/10 hover:text-blue-300 disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={commandInput}
            disabled={isRunningWorkflow}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRunSupervisor();
            }}
            placeholder="Describe an operational request for the Supervisor Agent (e.g., 'Delay milestone 2 by 4 days and recalculate critical path')…"
            className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={isRunningWorkflow || !commandInput.trim()}
            onClick={() => void handleRunSupervisor()}
            className="rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {isRunningWorkflow ? "Executing…" : "✦ Dispatch Supervisor"}
          </button>
        </div>
      </div>

      {/* ── Section 3: Pending Human Approvals, Financial & Scheduling Proposals */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Scheduling Proposals Queue */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <div>
              <h3 className="text-sm font-bold text-white">
                3A. Scheduling Proposals Queue (Planning & Reschedule Agents)
              </h3>
              <p className="text-[11px] text-slate-400">
                Validated Bryntum Gantt date shifts awaiting human authorization.
              </p>
            </div>
            <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 font-mono text-xs font-bold text-amber-300">
              {pendingSchedProposals.length} Pending
            </span>
          </div>

          <div className="mt-3 max-h-64 space-y-2.5 overflow-y-auto">
            {snapshot.scheduling_proposals.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-500">
                No scheduling proposals recorded yet. Run the Planning or Reschedule Agent above to generate one.
              </div>
            ) : (
              snapshot.scheduling_proposals.slice(0, 8).map((sp) => (
                <div
                  key={sp.proposal_id}
                  className="rounded-xl border border-slate-800 bg-slate-950/90 p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-blue-400">
                        {sp.proposal_id}
                      </span>
                      <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                        {sp.proposed_by_agent}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          sp.status === "approved"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : sp.status === "rejected"
                            ? "bg-rose-500/20 text-rose-300"
                            : "bg-amber-500/20 text-amber-300"
                        }`}
                      >
                        {sp.status.replace(/_/g, " ")}
                      </span>
                    </div>

                    {sp.status === "pending_approval" && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            void handleApprovalDecision({
                              executionId: sp.execution_id,
                              proposalId: sp.proposal_id,
                              decision: "approved",
                            })
                          }
                          className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500"
                        >
                          ✓ Authorize & Apply
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void handleApprovalDecision({
                              executionId: sp.execution_id,
                              proposalId: sp.proposal_id,
                              decision: "rejected",
                            })
                          }
                          className="rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/20"
                        >
                          ✕ Reject
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="mt-1.5 text-slate-300">{sp.rationale}</p>
                  <div className="mt-1 text-[11px] text-slate-500">
                    Adjustments: {Array.isArray(sp.adjustments) ? sp.adjustments.length : 0} task(s) • Risk:{" "}
                    <strong className="uppercase text-slate-300">{sp.overall_risk}</strong>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Financial Proposals & Pending Payout Approvals Queue */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <div>
              <h3 className="text-sm font-bold text-white">
                3B. Financial Proposals & Escrow Approvals (6-Stage Policy)
              </h3>
              <p className="text-[11px] text-slate-400">
                AI-assessed and deterministically validated payment proposals requiring human sign-off.
              </p>
            </div>
            <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 font-mono text-xs font-bold text-emerald-300">
              {snapshot.payment_proposals.length + snapshot.pending_payment_approvals.length} Total
            </span>
          </div>

          <div className="mt-3 max-h-64 space-y-2.5 overflow-y-auto">
            {pendingExecApprovals
              .filter((e) => e.delegated_agents?.includes("finance_agent"))
              .map((ex) => {
                const finOut = ex.structured_outputs?.finance_agent as
                  | { payment_proposal?: Record<string, unknown> }
                  | undefined;
                const pp = finOut?.payment_proposal;
                return (
                  <div
                    key={ex.execution_id}
                    className="rounded-xl border border-amber-500/30 bg-slate-950/90 p-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-mono font-semibold text-amber-300">
                          {String(pp?.proposal_id ?? ex.execution_id)}
                        </span>
                        <span className="ml-2 text-slate-300">
                          Net Payout:{" "}
                          <strong className="text-emerald-400">
                            ${(((Number(pp?.net_amount_cents) || 42500) / 100)).toFixed(2)} USD
                          </strong>
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            void handleApprovalDecision({
                              executionId: ex.execution_id,
                              decision: "approved",
                            })
                          }
                          className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500"
                        >
                          ✓ Authorize Payout
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void handleApprovalDecision({
                              executionId: ex.execution_id,
                              decision: "rejected",
                            })
                          }
                          className="rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/20"
                        >
                          ✕ Reject
                        </button>
                      </div>
                    </div>
                    <p className="mt-1 text-slate-300">
                      {String(pp?.ai_eligibility_assessment ?? ex.final_result)}
                    </p>
                  </div>
                );
              })}

            {snapshot.payment_proposals.map((pp) => (
              <div
                key={pp.proposal_id}
                className="rounded-xl border border-slate-800 bg-slate-950/90 p-3 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-semibold text-blue-400">
                    {pp.proposal_id}
                  </span>
                  <span className="font-mono font-bold text-emerald-400">
                    ${pp.amount_usd} USD
                  </span>
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase text-slate-300">
                    {pp.policy_decision} ({pp.status})
                  </span>
                </div>
                <p className="mt-1 text-slate-400">
                  Bound Commit SHA: <code className="text-slate-300">{pp.bound_head_sha}</code>
                </p>
                {pp.justification && (
                  <p className="mt-1 text-slate-300">{pp.justification}</p>
                )}
              </div>
            ))}

            {snapshot.payment_proposals.length === 0 &&
              pendingExecApprovals.filter((e) => e.delegated_agents?.includes("finance_agent"))
                .length === 0 && (
                <div className="py-6 text-center text-xs text-slate-500">
                  No financial proposals currently awaiting review. Dispatch the Finance Agent above to evaluate a milestone payout.
                </div>
              )}
          </div>
        </div>
      </div>

      {/* ── Section 4: Master Execution History + Detailed Execution Inspector ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left: Execution History Table (5 cols) */}
        <div className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/90 p-4 xl:col-span-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-sm font-bold text-white">
                4. Multi-Agent Execution History
              </h3>
              <p className="text-[11px] text-slate-400">
                Select any execution to inspect delegation handoffs, tool calls, and structured outputs.
              </p>
            </div>
            <span className="font-mono text-xs text-slate-400">
              {snapshot.executions.length} runs
            </span>
          </div>

          <div className="mt-3 max-h-[540px] space-y-2 overflow-y-auto pr-1">
            {snapshot.executions.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-500">
                No Supervisor executions recorded yet. Click any preset button above to run a multi-agent workflow.
              </div>
            ) : (
              snapshot.executions.map((ex) => {
                const isSelected =
                  selectedExecution?.execution_id === ex.execution_id;
                return (
                  <button
                    key={ex.execution_id}
                    type="button"
                    onClick={() => setSelectedExecutionId(ex.execution_id)}
                    className={`w-full rounded-xl border p-3 text-left transition ${
                      isSelected
                        ? "border-blue-500 bg-blue-600/15"
                        : "border-slate-800 bg-slate-950/70 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-blue-400">
                        {ex.execution_id}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          ex.status === "completed"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : ex.status === "awaiting_human_approval"
                            ? "bg-amber-500/20 text-amber-300"
                            : ex.status === "failed"
                            ? "bg-rose-500/20 text-rose-300"
                            : "bg-blue-500/20 text-blue-300"
                        }`}
                      >
                        {ex.status.replace(/_/g, " ")}
                      </span>
                    </div>

                    <div className="mt-1 line-clamp-1 text-xs font-medium text-slate-100">
                      {ex.user_request}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-slate-400">
                      <span>Intent: {ex.intent}</span>
                      <span>•</span>
                      <span>{ex.duration_ms}ms</span>
                      <span>•</span>
                      <span>{ex.total_tokens} tok</span>
                      <span>•</span>
                      <span>Retries: {ex.retry_count}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Execution Detail View (7 cols) */}
        <div className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/90 p-5 xl:col-span-7">
          {!selectedExecution ? (
            <div className="flex h-full items-center justify-center py-20 text-sm text-slate-500">
              Select an execution on the left or dispatch a Supervisor command above to inspect its operational trace.
            </div>
          ) : (
            <div className="space-y-4">
              {/* Header */}
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-blue-400">
                      {selectedExecution.execution_id}
                    </span>
                    <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-300">
                      Intent: {selectedExecution.intent}
                    </span>
                    <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-300">
                      Approval: {selectedExecution.approval_status}
                    </span>
                  </div>
                  <h3 className="mt-1.5 text-sm font-bold text-white">
                    User Request: &ldquo;{selectedExecution.user_request}&rdquo;
                  </h3>
                </div>

                {selectedExecution.approval_status === "pending" && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void handleApprovalDecision({
                          executionId: selectedExecution.execution_id,
                          decision: "approved",
                        })
                      }
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                    >
                      ✓ Authorize Execution
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleApprovalDecision({
                          executionId: selectedExecution.execution_id,
                          decision: "rejected",
                        })
                      }
                      className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/20"
                    >
                      ✕ Reject
                    </button>
                  </div>
                )}
              </div>

              {/* Supervisor Decision & Delegation Topology */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 text-xs">
                <div className="font-mono text-[10px] font-bold uppercase text-blue-400">
                  Supervisor Classification & Delegation Topology
                </div>
                <p className="mt-1 text-slate-300">
                  {selectedExecution.supervisor_decision?.decision_rationale ??
                    `Delegated to ${(selectedExecution.delegated_agents ?? []).join(", ")}.`}
                </p>

                {/* Visual Delegation Pipeline */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="rounded-lg border border-blue-500/40 bg-blue-500/15 px-3 py-1.5 font-mono text-xs font-bold text-blue-300">
                    Supervisor Agent
                  </span>
                  {(selectedExecution.delegated_agents ?? []).map((ag) => (
                    <React.Fragment key={ag}>
                      <span className="text-slate-500">──►</span>
                      <span className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 font-mono text-xs font-semibold text-emerald-300">
                        {ag}
                      </span>
                    </React.Fragment>
                  ))}
                  {selectedExecution.supervisor_decision?.requires_human_approval && (
                    <>
                      <span className="text-slate-500">──►</span>
                      <span className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 font-mono text-xs font-semibold text-amber-300">
                        🔒 Human Approval Gate ({selectedExecution.approval_status})
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Tool Calls Trace */}
              <div>
                <div className="mb-1.5 font-mono text-[10px] font-bold uppercase text-slate-400">
                  Deterministic Tool Calls ({selectedExecution.tool_calls?.length ?? 0})
                </div>
                <div className="space-y-1.5">
                  {(selectedExecution.tool_calls ?? []).map((tc, idx) => (
                    <div
                      key={`${tc.tool_name}-${idx}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs"
                    >
                      <div>
                        <span className="font-mono font-semibold text-blue-400">
                          {tc.tool_name}
                        </span>
                        <span className="ml-2 text-[11px] text-slate-400">
                          ({tc.agent_name})
                        </span>
                        <div className="mt-0.5 text-slate-300">{tc.output_summary}</div>
                      </div>
                      <span className="font-mono text-[11px] text-emerald-400">
                        {tc.duration_ms}ms • {tc.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Structured Specialist Agent Outputs */}
              <div>
                <div className="mb-1.5 font-mono text-[10px] font-bold uppercase text-slate-400">
                  Structured Agent Outputs (Pydantic Validated)
                </div>
                <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-300">
                  <pre className="whitespace-pre-wrap">
                    {JSON.stringify(selectedExecution.structured_outputs, null, 2)}
                  </pre>
                </div>
              </div>

              {/* Final Operational Result */}
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs">
                <div className="font-mono text-[10px] font-bold uppercase text-emerald-400">
                  Final Operational Result
                </div>
                <p className="mt-1 text-slate-100">{selectedExecution.final_result}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
