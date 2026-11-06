"""
Planning Agent — Generates structured project plans, Work Breakdown Structures (WBS),
dependencies, timeline estimates, project risks, milestones, and Bryntum-compatible task structures.
Returns validated proposals requiring human authorization before modifying project baselines.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import List, Optional, Tuple
from pydantic import BaseModel, Field

from backend.agents._llm import create_specialist_agent, has_groq_api_key, run_pydantic_agent
from backend.schemas.requests import PlanningAgentRequest
from backend.schemas.responses import PlanningAgentResponse, ToolCallRecord
from backend.schemas.tasks import (
    MilestoneAdjustment,
    ProjectRiskItem,
    SchedulingProposal,
    TaskState,
)
from backend.tools.bryntum import (
    build_bryntum_project_model,
    compute_critical_path_and_slack,
    detect_resource_and_schedule_conflicts,
)

logger = logging.getLogger("consultai.agents.planning")


class _LLMPlannedTask(BaseModel):
    name: str
    description: str
    duration_days: int = Field(default=5, ge=1, le=60)
    is_milestone: bool = Field(default=False)
    depends_on_indices: List[int] = Field(
        default_factory=list, description="0-based indices of predecessor tasks in this list"
    )
    budget_share_percent: int = Field(default=20, ge=0, le=100)


class _LLMPlanningOutput(BaseModel):
    summary: str
    tasks: List[_LLMPlannedTask]
    risks: List[ProjectRiskItem]


PLANNING_SYSTEM_PROMPT = (
    "You are the ConsultAI Principal Project Planning Agent.\n"
    "Given a consulting project title, brief, and budget, produce a rigorous Work Breakdown Structure (WBS) "
    "with 4 to 7 sequential and parallel tasks/milestones, explicit predecessor indices, realistic durations, "
    "budget share percentages summing to ~100%, and concrete project risks with mitigation plans.\n"
    "Never mutate production schedules directly; your output is packaged as a validated scheduling proposal."
)

planning_pydantic_agent = create_specialist_agent(
    name="planning_agent",
    output_type=_LLMPlanningOutput,
    system_prompt=PLANNING_SYSTEM_PROMPT,
)


async def execute_planning_agent(
    request: PlanningAgentRequest,
    execution_id: Optional[str] = None,
) -> Tuple[PlanningAgentResponse, List[ToolCallRecord], int, int, int]:
    """
    Runs the Planning Agent to generate a complete project plan, critical path analysis,
    and Bryntum Gantt task/dependency/resource structure.
    """
    tool_calls: List[ToolCallRecord] = []
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0

    base_start = datetime.utcnow()
    if request.start_date:
        try:
            base_start = datetime.strptime(request.start_date[:10], "%Y-%m-%d")
        except ValueError:
            pass

    tasks: List[TaskState] = []
    risks: List[ProjectRiskItem] = []
    summary_text = ""

    if has_groq_api_key():
        try:
            prompt = (
                f"Project ID: {request.project_id}\n"
                f"Project Title: {request.project_title}\n"
                f"Project Brief: {request.project_brief}\n"
                f"Total Budget (USD): ${(request.total_budget_cents / 100):,.2f}\n"
                f"Start Date: {base_start.strftime('%Y-%m-%d')}\n"
                f"Available Consultants: {len(request.available_consultants)}"
            )
            llm_out, p_tok, c_tok, t_tok = await run_pydantic_agent(planning_pydantic_agent, prompt)
            prompt_tokens += p_tok
            completion_tokens += c_tok
            total_tokens += t_tok
            summary_text = llm_out.summary
            risks = llm_out.risks

            # Convert LLM tasks into deterministic TaskState nodes with calculated dates
            task_ids = [f"ms-{uuid.uuid4().hex[:8]}" for _ in llm_out.tasks]
            task_end_dates: dict[int, datetime] = {}

            for idx, item in enumerate(llm_out.tasks):
                valid_preds = [p for p in item.depends_on_indices if 0 <= p < idx]
                if valid_preds:
                    t_start = max(task_end_dates[p] for p in valid_preds)
                else:
                    t_start = base_start + timedelta(days=idx * 2 if idx > 0 else 0)

                dur = 0 if item.is_milestone else max(1, item.duration_days)
                t_end = t_start + timedelta(days=max(1, dur))
                task_end_dates[idx] = t_end

                consultant = (
                    request.available_consultants[idx % len(request.available_consultants)]
                    if request.available_consultants
                    else None
                )
                amount_cents = int(round(request.total_budget_cents * (item.budget_share_percent / 100.0)))

                tasks.append(
                    TaskState(
                        id=task_ids[idx],
                        project_id=request.project_id,
                        name=item.name,
                        description=item.description,
                        wbs_code=f"1.{idx + 1}",
                        start_date=t_start.strftime("%Y-%m-%d"),
                        end_date=t_end.strftime("%Y-%m-%d"),
                        duration_days=dur,
                        percent_done=0,
                        status="scheduled",
                        is_milestone=item.is_milestone,
                        dependencies=[task_ids[p] for p in valid_preds],
                        assigned_consultant_id=str(consultant.get("id")) if consultant else None,
                        assigned_consultant_name=str(consultant.get("name")) if consultant else None,
                        allocated_hours=float(max(8, dur * 6)),
                        amount_cents=amount_cents,
                        baseline_start_date=t_start.strftime("%Y-%m-%d"),
                        baseline_end_date=t_end.strftime("%Y-%m-%d"),
                    )
                )
        except Exception as exc:
            logger.warning("Planning Agent LLM fallback triggered: %s", exc)

    if not tasks:
        # Use existing tasks if provided or construct structured WBS from brief
        if request.existing_tasks:
            tasks = [t.model_copy(deep=True) for t in request.existing_tasks]
            summary_text = (
                f"Analyzed {len(tasks)} existing project tasks for '{request.project_title}', "
                "computed critical path, and generated Bryntum Gantt schedule structures."
            )
        else:
            phases = [
                ("Architecture & Technical Discovery", "System architecture blueprint, API contracts, and security review", 5, False, [], 20),
                ("Core Platform & Database Implementation", "Schema migrations, domain services, and core backend pipelines", 8, False, [0], 35),
                ("Frontend Operations & Integrations", "Enterprise UI views, payment workflows, and webhook handlers", 7, False, [1], 30),
                ("Production Readiness & Sign-Off Milestone", "End-to-end verification, audit validation, and production release gate", 2, True, [2], 15),
            ]
            task_ids = [f"ms-{uuid.uuid4().hex[:8]}" for _ in phases]
            cursor = base_start
            for idx, (name, desc, dur, is_ms, preds, pct) in enumerate(phases):
                t_start = cursor
                t_end = t_start + timedelta(days=dur)
                cursor = t_end
                consultant = (
                    request.available_consultants[idx % len(request.available_consultants)]
                    if request.available_consultants
                    else None
                )
                tasks.append(
                    TaskState(
                        id=task_ids[idx],
                        project_id=request.project_id,
                        name=name,
                        description=desc,
                        wbs_code=f"1.{idx + 1}",
                        start_date=t_start.strftime("%Y-%m-%d"),
                        end_date=t_end.strftime("%Y-%m-%d"),
                        duration_days=dur,
                        percent_done=0,
                        status="scheduled",
                        is_milestone=is_ms,
                        dependencies=[task_ids[p] for p in preds],
                        assigned_consultant_id=str(consultant.get("id")) if consultant else None,
                        assigned_consultant_name=str(consultant.get("name")) if consultant else None,
                        allocated_hours=float(dur * 6),
                        amount_cents=int(round(request.total_budget_cents * (pct / 100.0))),
                        baseline_start_date=t_start.strftime("%Y-%m-%d"),
                        baseline_end_date=t_end.strftime("%Y-%m-%d"),
                    )
                )
            summary_text = (
                f"Generated a 4-stage WBS project plan for '{request.project_title}' "
                f"allocating ${(request.total_budget_cents / 100):,.2f} across {len(tasks)} milestones."
            )

    if not risks:
        risks = [
            ProjectRiskItem(
                risk_id="risk-dep-chain",
                category="dependency",
                severity="medium",
                title="Critical Path Sequential Bottleneck",
                description="Downstream integration milestones depend on timely completion of core architecture.",
                affected_task_ids=[t.id for t in tasks[:2]],
                mitigation_plan="Lock API contracts in week 1 so frontend and backend streams can proceed in parallel.",
            ),
            ProjectRiskItem(
                risk_id="risk-scope-verification",
                category="technical",
                severity="low",
                title="Deliverable Acceptance Criteria Ambiguity",
                description="Ambiguous PR acceptance criteria can delay automated delivery verification.",
                affected_task_ids=[t.id for t in tasks[-1:]],
                mitigation_plan="Enforce explicit deterministic acceptance checks per milestone before funding.",
            ),
        ]

    # Deterministic Bryntum tool call
    t0 = datetime.utcnow()
    enriched_tasks, critical_ids = compute_critical_path_and_slack(tasks)
    b_tasks, b_deps, b_res, b_asgn = build_bryntum_project_model(
        enriched_tasks, request.available_consultants
    )
    conflicts = detect_resource_and_schedule_conflicts(enriched_tasks)
    elapsed_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)

    tool_calls.append(
        ToolCallRecord(
            tool_name="bryntum.build_project_model",
            agent_name="planning_agent",
            inputs_summary={"project_id": request.project_id, "task_count": len(enriched_tasks)},
            output_summary=(
                f"Built {len(b_tasks)} Bryntum tasks, {len(b_deps)} dependencies, "
                f"{len(critical_ids)} critical path nodes, {len(conflicts)} conflicts."
            ),
            status="success",
            duration_ms=max(1, elapsed_ms),
        )
    )

    total_duration = sum(max(1, t.duration_days) for t in enriched_tasks)
    proposal = SchedulingProposal(
        proposal_id=f"sprop-{uuid.uuid4().hex[:10]}",
        project_id=request.project_id,
        execution_id=execution_id,
        proposed_by_agent="planning_agent",
        status="pending_approval",
        overall_risk="medium" if conflicts else "low",
        total_delay_days=0,
        rationale=summary_text,
        adjustments=[
            MilestoneAdjustment(
                task_id=t.id,
                task_name=t.name,
                previous_start_date=t.start_date,
                previous_end_date=t.end_date,
                proposed_start_date=t.start_date,
                proposed_end_date=t.end_date,
                delta_days=0,
                expected_version=t.version,
                reason="Initial WBS baseline schedule proposal",
            )
            for t in enriched_tasks
        ],
        conflicts_resolved=conflicts,
        bryntum_tasks_preview=b_tasks,
        bryntum_dependencies_preview=b_deps,
        requires_human_approval=True,
    )

    response = PlanningAgentResponse(
        project_id=request.project_id,
        summary=summary_text,
        estimated_total_duration_days=total_duration,
        critical_path_task_ids=critical_ids,
        tasks=enriched_tasks,
        bryntum_tasks=b_tasks,
        bryntum_dependencies=b_deps,
        bryntum_resources=b_res,
        bryntum_assignments=b_asgn,
        risks=risks,
        scheduling_proposal=proposal,
        requires_human_approval=True,
    )
    return response, tool_calls, prompt_tokens, completion_tokens, total_tokens
