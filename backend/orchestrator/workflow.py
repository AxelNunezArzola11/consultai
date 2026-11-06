"""
Pydantic Graph Multi-Step Workflow Engine for Complex Multi-Agent Orchestration.
Implements a typed state machine:
ClassifyRequestNode -> LoadContextNode -> DelegateSpecialistsNode -> ApprovalGateNode -> FinalizeExecutionNode
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Union
from pydantic_graph import BaseNode, End, GraphBuilder, GraphRunContext

from backend.agents._llm import create_specialist_agent, has_groq_api_key, run_pydantic_agent
from backend.agents.delivery import execute_delivery_agent
from backend.agents.finance import execute_finance_agent
from backend.agents.planning import execute_planning_agent
from backend.agents.reschedule import execute_reschedule_agent
from backend.agents.talent import execute_talent_agent
from backend.orchestrator.state import WorkflowGraphState, telemetry_registry
from backend.schemas.approvals import ApprovalRequest
from backend.schemas.requests import (
    DeliveryAgentRequest,
    FinanceAgentRequest,
    PlanningAgentRequest,
    RescheduleAgentRequest,
    TalentAgentRequest,
)
from backend.schemas.responses import (
    AgentExecutionError,
    AgentHandoff,
    SupervisorClassification,
    SupervisorResponse,
    ToolCallRecord,
)
from backend.schemas.tasks import TaskState
from backend.services.notifications import broadcaster
from backend.tools.database import fetch_project_context

logger = logging.getLogger("consultai.orchestrator.workflow")

SUPERVISOR_SYSTEM_PROMPT = (
    "You are the Central Supervisor Agent for ConsultAI.\n"
    "Classify the user request into one of the operational intents and select the minimal ordered set of "
    "specialist agents required to fulfill the request:\n"
    "- `planning_agent`: For generating project plans, WBS task breakdowns, timelines, risks, or milestones.\n"
    "- `talent_agent`: For evaluating consultants, analyzing GitHub evidence, or matching skills.\n"
    "- `delivery_agent`: For verifying PRs, GitHub webhooks, deliverables, or acceptance criteria.\n"
    "- `finance_agent`: For calculating milestone payouts, fees, payment eligibility, or payment proposals.\n"
    "- `reschedule_agent`: For analyzing project delays, cascading dependency shifts, or rescheduling dates.\n"
    "Set `requires_human_approval=True` whenever `finance_agent`, `reschedule_agent`, or `planning_agent` is selected."
)

supervisor_classifier_agent = create_specialist_agent(
    name="supervisor_classifier",
    output_type=SupervisorClassification,
    system_prompt=SUPERVISOR_SYSTEM_PROMPT,
)


def deterministic_classify(user_request: str, operation_type: str) -> SupervisorClassification:
    """Deterministic classification & fallback when explicit operation_type is provided or LLM is offline."""
    text = user_request.lower()

    if operation_type == "project_planning":
        return SupervisorClassification(
            intent="project_planning",
            selected_agents=["planning_agent"],
            requires_human_approval=True,
            decision_rationale="Routed to Planning Agent to generate structured WBS, critical path, and Bryntum schedule proposal.",
        )
    if operation_type == "talent_evaluation":
        return SupervisorClassification(
            intent="talent_evaluation",
            selected_agents=["talent_agent"],
            requires_human_approval=False,
            decision_rationale="Routed to Talent Agent to evaluate consultant profiles and verify GitHub repository evidence.",
        )
    if operation_type == "delivery_verification":
        return SupervisorClassification(
            intent="delivery_verification",
            selected_agents=["delivery_agent", "finance_agent"],
            requires_human_approval=True,
            decision_rationale="Routed to Delivery Agent for PR/criteria verification followed by Finance Agent for payout eligibility assessment.",
        )
    if operation_type == "financial_assessment":
        return SupervisorClassification(
            intent="financial_assessment",
            selected_agents=["finance_agent"],
            requires_human_approval=True,
            decision_rationale="Routed to Finance Agent to evaluate milestone payment eligibility and create a human-gated payment proposal.",
        )
    if operation_type == "schedule_reschedule":
        return SupervisorClassification(
            intent="schedule_reschedule",
            selected_agents=["reschedule_agent"],
            requires_human_approval=True,
            decision_rationale="Routed to Reschedule Agent to compute Finish-to-Start dependency cascade and Bryntum date adjustments.",
        )
    if operation_type == "full_project_review":
        return SupervisorClassification(
            intent="full_project_review",
            selected_agents=["planning_agent", "talent_agent", "reschedule_agent", "finance_agent"],
            requires_human_approval=True,
            decision_rationale="Coordinated full-project review across Planning, Talent, Reschedule, and Finance specialist agents.",
        )

    # Keyword-based auto classification
    selected: List[Any] = []
    if any(k in text for k in ("delay", "reschedul", "slip", "shift", "postpone", "late", "cascade")):
        selected.append("reschedule_agent")
    if any(k in text for k in ("plan", "wbs", "gantt", "breakdown", "roadmap", "baseline")):
        selected.append("planning_agent")
    if any(k in text for k in ("talent", "candidate", "consultant", "github", "vet", "skill", "hire")):
        selected.append("talent_agent")
    if any(k in text for k in ("deliver", "pr", "pull request", "commit", "webhook", "verify", "criteria")):
        selected.append("delivery_agent")
    if any(k in text for k in ("pay", "payout", "finance", "escrow", "invoice", "release", "budget", "fee")):
        selected.append("finance_agent")

    if not selected:
        selected = ["planning_agent"]

    intent_map: Dict[str, Any] = {
        "planning_agent": "project_planning",
        "talent_agent": "talent_evaluation",
        "delivery_agent": "delivery_verification",
        "finance_agent": "financial_assessment",
        "reschedule_agent": "schedule_reschedule",
    }
    intent = "full_project_review" if len(selected) > 2 else intent_map.get(selected[0], "project_planning")
    needs_approval = any(a in ("finance_agent", "reschedule_agent", "planning_agent") for a in selected)

    return SupervisorClassification(
        intent=intent,
        selected_agents=selected,
        requires_human_approval=needs_approval,
        decision_rationale=(
            f"Supervisor classified request as '{intent}' and selected {', '.join(selected)} "
            f"based on operational intent."
        ),
    )


@dataclass
class ClassifyRequestNode(BaseNode[WorkflowGraphState, None, SupervisorResponse]):
    """Step 1: Supervisor classifies the user request and determines specialist delegation."""

    async def run(
        self, ctx: GraphRunContext[WorkflowGraphState]
    ) -> "LoadContextNode":
        state = ctx.state
        req = state.request

        if req.operation_type != "auto":
            classification = deterministic_classify(req.user_request, req.operation_type)
        elif has_groq_api_key():
            try:
                prompt = (
                    f"User Request: {req.user_request}\n"
                    f"Actor Role: {req.actor_role}\n"
                    f"Project ID: {req.project_id or 'default'}\n"
                    f"Context Keys: {list(req.context.keys())}"
                )
                classification, p_tok, c_tok, t_tok = await run_pydantic_agent(
                    supervisor_classifier_agent, prompt
                )
                state.prompt_tokens += p_tok
                state.completion_tokens += c_tok
                state.total_tokens += t_tok
            except Exception as exc:
                logger.warning("Supervisor LLM classification fallback: %s", exc)
                classification = deterministic_classify(req.user_request, "auto")
        else:
            classification = deterministic_classify(req.user_request, "auto")

        state.classification = classification
        state.delegated_agents = list(classification.selected_agents)

        await broadcaster.publish(
            "supervisor_classified",
            {
                "execution_id": state.execution_id,
                "intent": classification.intent,
                "selected_agents": classification.selected_agents,
                "rationale": classification.decision_rationale,
            },
        )
        return LoadContextNode()


@dataclass
class LoadContextNode(BaseNode[WorkflowGraphState, None, SupervisorResponse]):
    """Step 2: Loads shared project, milestone, and candidate state from Neon PostgreSQL."""

    async def run(
        self, ctx: GraphRunContext[WorkflowGraphState]
    ) -> "DelegateSpecialistsNode":
        state = ctx.state
        t0 = datetime.utcnow()
        db_ctx = await fetch_project_context(state.request.project_id)
        dur_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)

        state.db_context = db_ctx
        if db_ctx.get("project") and not state.request.project_id:
            state.request.project_id = str(db_ctx["project"]["id"])

        state.tool_calls.append(
            ToolCallRecord(
                tool_name="database.fetch_project_context",
                agent_name="supervisor_agent",
                inputs_summary={"project_id": state.request.project_id},
                output_summary=(
                    f"Loaded project={bool(db_ctx.get('project'))}, "
                    f"milestones={len(db_ctx.get('milestones', []))}, "
                    f"candidates={len(db_ctx.get('candidates', []))}"
                ),
                status="success",
                duration_ms=max(1, dur_ms),
            )
        )
        return DelegateSpecialistsNode()


def _extract_tasks_from_state(state: WorkflowGraphState) -> List[TaskState]:
    """Builds canonical TaskState list from request context or loaded DB milestones."""
    ctx_tasks = state.request.context.get("tasks")
    project_id = state.request.project_id or "proj-default"
    if isinstance(ctx_tasks, list) and ctx_tasks:
        parsed: List[TaskState] = []
        for idx, raw in enumerate(ctx_tasks):
            if isinstance(raw, TaskState):
                parsed.append(raw)
            elif isinstance(raw, dict):
                parsed.append(
                    TaskState(
                        id=str(raw.get("id") or f"ms-{idx+1}"),
                        project_id=str(raw.get("project_id") or project_id),
                        name=str(raw.get("name") or raw.get("title") or f"Milestone {idx+1}"),
                        description=raw.get("description"),
                        start_date=str(raw.get("start_date") or raw.get("startDate") or datetime.utcnow().strftime("%Y-%m-%d"))[:10],
                        end_date=str(raw.get("end_date") or raw.get("endDate") or raw.get("due_date") or (datetime.utcnow() + timedelta(days=5)).strftime("%Y-%m-%d"))[:10],
                        duration_days=int(raw.get("duration_days") or raw.get("duration") or 5),
                        percent_done=int(raw.get("percent_done") or raw.get("percentDone") or 0),
                        status=raw.get("status") if raw.get("status") in ("draft", "scheduled", "in_progress", "funded", "in_verification", "ready_for_payout", "paid", "blocked", "delayed") else "scheduled",
                        dependencies=list(raw.get("dependencies") or ([raw["depends_on"]] if raw.get("depends_on") else [])),
                        assigned_consultant_id=raw.get("assigned_consultant_id"),
                        assigned_consultant_name=raw.get("assigned_consultant_name"),
                        amount_cents=int(raw.get("amount_cents") or 500000),
                        version=int(raw.get("version") or 1),
                    )
                )
        if parsed:
            return parsed

    db_milestones = state.db_context.get("milestones") or []
    db_candidates = state.db_context.get("candidates") or []
    if db_milestones:
        tasks: List[TaskState] = []
        base_dt = datetime.utcnow()
        for idx, m in enumerate(db_milestones):
            s_val = m.get("start_date")
            e_val = m.get("due_date")
            s_str = (
                s_val.strftime("%Y-%m-%d")
                if isinstance(s_val, datetime)
                else (str(s_val)[:10] if s_val else (base_dt + timedelta(days=idx * 5)).strftime("%Y-%m-%d"))
            )
            e_str = (
                e_val.strftime("%Y-%m-%d")
                if isinstance(e_val, datetime)
                else (str(e_val)[:10] if e_val else (base_dt + timedelta(days=(idx + 1) * 5)).strftime("%Y-%m-%d"))
            )
            cand = db_candidates[idx % len(db_candidates)] if db_candidates else None
            raw_status = str(m.get("status") or "draft")
            mapped_status: Any = (
                raw_status
                if raw_status in ("draft", "funded", "in_verification", "ready_for_payout", "paid")
                else "scheduled"
            )
            pct = 100 if mapped_status == "paid" else (80 if mapped_status == "ready_for_payout" else (50 if mapped_status in ("funded", "in_verification") else 15))
            tasks.append(
                TaskState(
                    id=str(m["id"]),
                    project_id=str(m.get("project_id") or project_id),
                    name=str(m.get("title") or f"Milestone {idx+1}"),
                    description=m.get("description"),
                    wbs_code=f"1.{idx+1}",
                    start_date=s_str,
                    end_date=e_str,
                    duration_days=5,
                    percent_done=pct,
                    status=mapped_status,
                    dependencies=[str(m["depends_on"])] if m.get("depends_on") else ([str(db_milestones[idx - 1]["id"])] if idx > 0 else []),
                    assigned_consultant_id=str(cand["id"]) if cand else None,
                    assigned_consultant_name=str(cand["name"]) if cand else None,
                    amount_cents=int(m.get("amount_cents") or 500000),
                    version=int(m.get("version") or 1),
                )
            )
        return tasks

    # Default structured tasks if DB has none for this project ID
    base = datetime.utcnow()
    t1_id = "ms-arch-1"
    t2_id = "ms-impl-2"
    t3_id = "ms-verif-3"
    return [
        TaskState(
            id=t1_id,
            project_id=project_id,
            name="Phase 1: System Architecture & Escrow Setup",
            description="Define multi-agent schemas, database contracts, and security boundaries",
            wbs_code="1.1",
            start_date=base.strftime("%Y-%m-%d"),
            end_date=(base + timedelta(days=5)).strftime("%Y-%m-%d"),
            duration_days=5,
            percent_done=100,
            status="paid",
            dependencies=[],
            amount_cents=600000,
            version=1,
        ),
        TaskState(
            id=t2_id,
            project_id=project_id,
            name="Phase 2: Multi-Agent Backend & Gantt Integration",
            description="Implement Supervisor orchestration, Bryntum Gantt sync, and AG Grid views",
            wbs_code="1.2",
            start_date=(base + timedelta(days=5)).strftime("%Y-%m-%d"),
            end_date=(base + timedelta(days=12)).strftime("%Y-%m-%d"),
            duration_days=7,
            percent_done=60,
            status="in_verification",
            dependencies=[t1_id],
            amount_cents=1000000,
            version=1,
        ),
        TaskState(
            id=t3_id,
            project_id=project_id,
            name="Phase 3: AI Operations Center & Production Release",
            description="Deploy live SSE telemetry, approval gates, and production readiness",
            wbs_code="1.3",
            start_date=(base + timedelta(days=12)).strftime("%Y-%m-%d"),
            end_date=(base + timedelta(days=18)).strftime("%Y-%m-%d"),
            duration_days=6,
            percent_done=20,
            status="scheduled",
            is_milestone=True,
            dependencies=[t2_id],
            amount_cents=900000,
            version=1,
        ),
    ]


@dataclass
class DelegateSpecialistsNode(BaseNode[WorkflowGraphState, None, SupervisorResponse]):
    """Step 3: Delegates tasks sequentially/contextually to the selected Specialist Agents."""

    async def run(
        self, ctx: GraphRunContext[WorkflowGraphState]
    ) -> "ApprovalGateNode":
        state = ctx.state
        req = state.request
        project_row = state.db_context.get("project") or {}
        project_id = req.project_id or str(project_row.get("id") or "proj-default")
        project_title = str(
            req.context.get("project_title")
            or project_row.get("title")
            or "Enterprise Consulting Engagement"
        )
        project_brief = str(
            req.context.get("project_brief")
            or project_row.get("brief")
            or req.user_request
        )
        total_budget_cents = int(
            req.context.get("total_budget_cents")
            or project_row.get("budget_cents")
            or 2500000
        )
        candidates_pool = state.db_context.get("candidates") or req.context.get("candidates") or []
        tasks = _extract_tasks_from_state(state)

        last_trust_score = int(req.context.get("trust_score") or 85)
        last_all_criteria_passed = bool(req.context.get("all_criteria_passed", True))
        last_delivery_summary = ""

        for agent_name in state.delegated_agents:
            handoff_id = f"ho-{uuid.uuid4().hex[:10]}"
            t_start = datetime.utcnow()
            telemetry_registry.mark_started(agent_name)

            await broadcaster.publish(
                "agent_delegated",
                {
                    "execution_id": state.execution_id,
                    "handoff_id": handoff_id,
                    "to_agent": agent_name,
                    "project_id": project_id,
                },
            )

            try:
                if agent_name == "planning_agent":
                    p_req = PlanningAgentRequest(
                        project_id=project_id,
                        project_title=project_title,
                        project_brief=project_brief,
                        total_budget_cents=total_budget_cents,
                        start_date=req.context.get("start_date"),
                        existing_tasks=tasks if req.context.get("use_existing_tasks") else [],
                        available_consultants=candidates_pool,
                    )
                    p_resp, t_calls, p_tok, c_tok, tot_tok = await execute_planning_agent(
                        p_req, execution_id=state.execution_id
                    )
                    state.structured_outputs["planning_agent"] = p_resp.model_dump()
                    state.tool_calls.extend(t_calls)
                    state.prompt_tokens += p_tok
                    state.completion_tokens += c_tok
                    state.total_tokens += tot_tok
                    tasks = p_resp.tasks
                    if p_resp.scheduling_proposal:
                        state.scheduling_proposals.append(p_resp.scheduling_proposal)

                elif agent_name == "talent_agent":
                    t_req = TalentAgentRequest(
                        project_id=project_id,
                        project_requirements=req.context.get("project_requirements")
                        or ["TypeScript", "Next.js", "Python", "FastAPI", "PostgreSQL"],
                        project_brief=project_brief,
                        candidate_id=req.candidate_id,
                        candidate_name=req.context.get("candidate_name"),
                        github_username=req.context.get("github_username"),
                        role_title=str(req.context.get("role_title") or "Senior AI & Full-Stack Consultant"),
                        candidates_pool=candidates_pool,
                    )
                    t_resp, t_calls, p_tok, c_tok, tot_tok = await execute_talent_agent(t_req)
                    state.structured_outputs["talent_agent"] = t_resp.model_dump()
                    state.tool_calls.extend(t_calls)
                    state.prompt_tokens += p_tok
                    state.completion_tokens += c_tok
                    state.total_tokens += tot_tok

                elif agent_name == "delivery_agent":
                    target_ms = req.milestone_id or (tasks[0].id if tasks else "ms-default")
                    d_req = DeliveryAgentRequest(
                        project_id=project_id,
                        milestone_id=target_ms,
                        milestone_title=str(req.context.get("milestone_title") or "Milestone Deliverable"),
                        acceptance_criteria=req.context.get("acceptance_criteria") or [],
                        pr_url=req.context.get("pr_url"),
                        repository_full_name=req.context.get("repository_full_name"),
                        pr_number=req.context.get("pr_number"),
                        head_sha=req.context.get("head_sha") or "sha-verified-local",
                        pr_title=str(req.context.get("pr_title") or req.user_request[:100]),
                        pr_body=str(req.context.get("pr_body") or req.user_request),
                        diff_summary=str(req.context.get("diff_summary") or "Modified backend orchestration and UI components"),
                        changed_files=req.context.get("changed_files") or ["backend/main.py", "components/bryntum-gantt/BryntumGantt.tsx"],
                        ci_checks_passed=req.context.get("ci_checks_passed", True),
                    )
                    d_resp, t_calls, p_tok, c_tok, tot_tok = await execute_delivery_agent(d_req)
                    state.structured_outputs["delivery_agent"] = d_resp.model_dump()
                    state.tool_calls.extend(t_calls)
                    state.prompt_tokens += p_tok
                    state.completion_tokens += c_tok
                    state.total_tokens += tot_tok
                    last_trust_score = d_resp.trust_score
                    last_all_criteria_passed = len(d_resp.incomplete_work_items) == 0
                    last_delivery_summary = d_resp.summary

                elif agent_name == "finance_agent":
                    target_ms_obj = next(
                        (t for t in tasks if t.id == req.milestone_id),
                        tasks[1] if len(tasks) > 1 else (tasks[0] if tasks else None),
                    )
                    target_ms_id = req.milestone_id or (target_ms_obj.id if target_ms_obj else "ms-default")
                    target_ms_title = (
                        str(req.context.get("milestone_title"))
                        if req.context.get("milestone_title")
                        else (target_ms_obj.name if target_ms_obj else "Verified Project Milestone")
                    )
                    gross_cents = int(
                        req.context.get("gross_amount_cents")
                        or (target_ms_obj.amount_cents if target_ms_obj and target_ms_obj.amount_cents > 0 else 500000)
                    )
                    recipient = str(
                        req.context.get("recipient_email")
                        or (candidates_pool[0].get("email") if candidates_pool and candidates_pool[0].get("email") else "consultant-verified@consultai.io")
                    )
                    f_req = FinanceAgentRequest(
                        project_id=project_id,
                        milestone_id=target_ms_id,
                        milestone_title=target_ms_title,
                        recipient_email=recipient,
                        gross_amount_cents=gross_cents,
                        project_total_budget_cents=total_budget_cents,
                        project_already_paid_cents=int(req.context.get("project_already_paid_cents") or 0),
                        currency=str(req.context.get("currency") or "USD"),
                        trust_score=last_trust_score,
                        all_criteria_passed=last_all_criteria_passed,
                        head_sha_verified=bool(req.context.get("head_sha_verified", True)),
                        delivery_summary=last_delivery_summary or req.user_request,
                    )
                    f_resp, t_calls, p_tok, c_tok, tot_tok = await execute_finance_agent(
                        f_req, execution_id=state.execution_id
                    )
                    state.structured_outputs["finance_agent"] = f_resp.model_dump()
                    state.tool_calls.extend(t_calls)
                    state.prompt_tokens += p_tok
                    state.completion_tokens += c_tok
                    state.total_tokens += tot_tok
                    state.payment_proposals.append(f_resp.payment_proposal)

                elif agent_name == "reschedule_agent":
                    unlocked_tasks = [t for t in tasks if t.status not in ("funded", "paid")]
                    default_delayed = unlocked_tasks[0].id if unlocked_tasks else (tasks[0].id if tasks else None)
                    r_req = RescheduleAgentRequest(
                        project_id=project_id,
                        delayed_task_id=req.milestone_id or req.context.get("delayed_task_id") or default_delayed,
                        delay_days=int(req.context.get("delay_days") or 4),
                        delay_reason=str(req.context.get("delay_reason") or req.user_request),
                        tasks=tasks,
                    )
                    r_resp, t_calls, p_tok, c_tok, tot_tok = await execute_reschedule_agent(
                        r_req, execution_id=state.execution_id
                    )
                    state.structured_outputs["reschedule_agent"] = r_resp.model_dump()
                    state.tool_calls.extend(t_calls)
                    state.prompt_tokens += p_tok
                    state.completion_tokens += c_tok
                    state.total_tokens += tot_tok
                    state.scheduling_proposals.append(r_resp.scheduling_proposal)

                dur_ms = int((datetime.utcnow() - t_start).total_seconds() * 1000)
                telemetry_registry.mark_finished(
                    agent_name, duration_ms=max(1, dur_ms), tokens=tot_tok, success=True
                )
                state.handoffs.append(
                    AgentHandoff(
                        handoff_id=handoff_id,
                        from_agent="supervisor_agent",
                        to_agent=agent_name,
                        reason=f"Delegated '{agent_name}' for {state.classification.intent if state.classification else 'workflow'}",
                        context_keys=list(req.context.keys()) + ["project_id", "tasks"],
                        status="completed",
                        duration_ms=max(1, dur_ms),
                    )
                )
            except Exception as exc:
                dur_ms = int((datetime.utcnow() - t_start).total_seconds() * 1000)
                telemetry_registry.mark_finished(
                    agent_name, duration_ms=max(1, dur_ms), tokens=0, success=False
                )
                logger.error("Specialist agent %s failed: %s", agent_name, exc)
                state.errors.append(
                    AgentExecutionError(
                        error_code="AGENT_EXECUTION_ERROR",
                        agent_name=agent_name,
                        message=str(exc),
                        recoverable=True,
                        retry_attempt=state.retry_count,
                    )
                )
                state.handoffs.append(
                    AgentHandoff(
                        handoff_id=handoff_id,
                        from_agent="supervisor_agent",
                        to_agent=agent_name,
                        reason="Specialist execution encountered an error",
                        context_keys=list(req.context.keys()),
                        status="failed",
                        duration_ms=max(1, dur_ms),
                    )
                )

        return ApprovalGateNode()


@dataclass
class ApprovalGateNode(BaseNode[WorkflowGraphState, None, SupervisorResponse]):
    """
    Step 4: Evaluates whether any sensitive proposals (financial payouts or schedule mutations)
    were generated and creates explicit Human Approval Requests.
    """

    async def run(
        self, ctx: GraphRunContext[WorkflowGraphState]
    ) -> "FinalizeExecutionNode":
        state = ctx.state
        project_id = state.request.project_id or "proj-default"

        for pp in state.payment_proposals:
            state.pending_approvals.append(
                ApprovalRequest(
                    approval_id=f"appr-{uuid.uuid4().hex[:10]}",
                    execution_id=state.execution_id,
                    project_id=project_id,
                    milestone_id=pp.milestone_id,
                    operation_type="milestone_payout",
                    requested_by_agent="finance_agent",
                    title=f"Authorize Milestone Payout: ${pp.net_amount_cents / 100:,.2f} {pp.currency} Net",
                    summary=pp.ai_eligibility_assessment,
                    payload=pp.model_dump(),
                    policy_passed=pp.policy_evaluation.passed,
                    status="pending",
                )
            )

        for sp in state.scheduling_proposals:
            op_type: Any = (
                "project_plan_baseline"
                if sp.proposed_by_agent == "planning_agent"
                else "schedule_reschedule"
            )
            state.pending_approvals.append(
                ApprovalRequest(
                    approval_id=f"appr-{uuid.uuid4().hex[:10]}",
                    execution_id=state.execution_id,
                    project_id=project_id,
                    operation_type=op_type,
                    requested_by_agent=sp.proposed_by_agent,
                    title=f"Authorize Schedule Proposal ({len(sp.adjustments)} task adjustments)",
                    summary=sp.rationale,
                    payload=sp.model_dump(),
                    policy_passed=True,
                    status="pending",
                )
            )

        if state.pending_approvals:
            state.status = "awaiting_human_approval"
            state.approval_status = "pending"
        elif state.errors and not state.structured_outputs:
            state.status = "failed"
            state.approval_status = "not_required"
        else:
            state.status = "completed"
            state.approval_status = "not_required"

        return FinalizeExecutionNode()


@dataclass
class FinalizeExecutionNode(BaseNode[WorkflowGraphState, None, SupervisorResponse]):
    """Step 5: Synthesizes the final SupervisorResponse and emits real-time SSE completion event."""

    async def run(
        self, ctx: GraphRunContext[WorkflowGraphState]
    ) -> End[SupervisorResponse]:
        state = ctx.state
        duration_ms = max(1, int((datetime.utcnow() - state.started_at).total_seconds() * 1000))

        summaries: List[str] = []
        for agent_key, output_dict in state.structured_outputs.items():
            if isinstance(output_dict, dict) and output_dict.get("summary"):
                summaries.append(f"[{agent_key}] {output_dict['summary']}")

        if state.pending_approvals:
            summaries.append(
                f"Execution paused at Human Approval Gate with {len(state.pending_approvals)} pending authorization(s)."
            )

        final_summary = " | ".join(summaries) if summaries else "Supervisor execution completed."
        state.final_result = final_summary

        classification = state.classification or deterministic_classify(
            state.request.user_request, state.request.operation_type
        )

        response = SupervisorResponse(
            execution_id=state.execution_id,
            project_id=state.request.project_id,
            user_request=state.request.user_request,
            status=state.status,
            approval_status=state.approval_status,
            supervisor_decision=classification,
            delegated_agents=state.delegated_agents,
            handoffs=state.handoffs,
            tool_calls=state.tool_calls,
            structured_outputs=state.structured_outputs,
            pending_approvals=state.pending_approvals,
            payment_proposals=state.payment_proposals,
            scheduling_proposals=state.scheduling_proposals,
            errors=state.errors,
            retry_count=state.retry_count,
            prompt_tokens=state.prompt_tokens,
            completion_tokens=state.completion_tokens,
            total_tokens=state.total_tokens,
            duration_ms=duration_ms,
            final_result=final_summary,
        )

        await broadcaster.publish(
            "execution_completed",
            {
                "execution_id": response.execution_id,
                "status": response.status,
                "approval_status": response.approval_status,
                "delegated_agents": response.delegated_agents,
                "duration_ms": response.duration_ms,
                "total_tokens": response.total_tokens,
                "final_result": response.final_result,
            },
        )
        return End(response)


def _build_supervisor_graph():
    builder = GraphBuilder(
        name="consultai_supervisor_workflow",
        state_type=WorkflowGraphState,
        input_type=ClassifyRequestNode,
        output_type=SupervisorResponse,
    )
    builder.add(
        builder.edge_from(builder.start_node).to(ClassifyRequestNode),
        builder.node(ClassifyRequestNode),
        builder.node(LoadContextNode),
        builder.node(DelegateSpecialistsNode),
        builder.node(ApprovalGateNode),
        builder.node(FinalizeExecutionNode),
    )
    return builder.build()


supervisor_workflow_graph = _build_supervisor_graph()
