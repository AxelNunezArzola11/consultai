"""
Reschedule Agent — Analyzes project delays, identifies affected dependencies,
recommends scheduling adjustments, calculates proposed new dates, and provides
validated structured changes for Bryntum Gantt.
Never modifies project schedules without human authorization.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import List, Literal, Optional, Tuple
from pydantic import BaseModel, Field

from backend.agents._llm import create_specialist_agent, has_groq_api_key, run_pydantic_agent
from backend.policies.validation import validate_schedule_adjustments
from backend.schemas.requests import RescheduleAgentRequest
from backend.schemas.responses import RescheduleAgentResponse, ToolCallRecord
from backend.schemas.tasks import SchedulingProposal
from backend.tools.bryntum import (
    build_bryntum_project_model,
    calculate_reschedule_cascade,
    detect_resource_and_schedule_conflicts,
)

logger = logging.getLogger("consultai.agents.reschedule")


class _LLMRescheduleRationale(BaseModel):
    overall_risk: Literal["low", "medium", "high", "critical"] = Field(default="medium")
    rationale: str
    executive_summary: str


RESCHEDULE_SYSTEM_PROMPT = (
    "You are the ConsultAI Principal Schedule Recovery & Critical Path Agent.\n"
    "Given a project delay and the deterministically calculated Finish-to-Start cascade adjustments, "
    "assess the overall schedule risk and write a concise, actionable rationale for the human operator.\n"
    "Funded and paid milestones are financially locked and must never be shifted."
)

reschedule_pydantic_agent = create_specialist_agent(
    name="reschedule_agent",
    output_type=_LLMRescheduleRationale,
    system_prompt=RESCHEDULE_SYSTEM_PROMPT,
)


async def execute_reschedule_agent(
    request: RescheduleAgentRequest,
    execution_id: Optional[str] = None,
) -> Tuple[RescheduleAgentResponse, List[ToolCallRecord], int, int, int]:
    """
    Executes the Reschedule Agent:
    1. Runs deterministic Finish-to-Start cascade calculation skipping funded/paid milestones.
    2. Validates proposed adjustments against DAG & lock policies.
    3. Synthesizes risk assessment and produces a Bryntum-compatible `SchedulingProposal`.
    """
    tool_calls: List[ToolCallRecord] = []
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0

    t0 = datetime.utcnow()
    raw_adjustments, updated_tasks = calculate_reschedule_cascade(
        tasks=request.tasks,
        delayed_task_id=request.delayed_task_id,
        delay_days=request.delay_days,
        delay_reason=request.delay_reason,
    )
    is_valid, validation_conflicts, sanitized_adjustments = validate_schedule_adjustments(
        request.tasks, raw_adjustments
    )
    schedule_conflicts = detect_resource_and_schedule_conflicts(updated_tasks)
    all_conflicts = validation_conflicts + schedule_conflicts
    b_tasks, b_deps, _, _ = build_bryntum_project_model(updated_tasks)
    dur_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)

    tool_calls.append(
        ToolCallRecord(
            tool_name="bryntum.calculate_reschedule_cascade",
            agent_name="reschedule_agent",
            inputs_summary={
                "project_id": request.project_id,
                "delayed_task_id": request.delayed_task_id,
                "delay_days": request.delay_days,
            },
            output_summary=(
                f"Calculated {len(sanitized_adjustments)} valid milestone date adjustments, "
                f"valid={is_valid}, conflicts={len(all_conflicts)}."
            ),
            status="success",
            duration_ms=max(1, dur_ms),
        )
    )

    overall_risk: Literal["low", "medium", "high", "critical"] = (
        "high" if abs(request.delay_days) >= 7 or all_conflicts else ("medium" if abs(request.delay_days) >= 3 else "low")
    )
    rationale = (
        f"Propagated a {request.delay_days:+d} day shift across {len(sanitized_adjustments)} downstream task(s) "
        f"due to: {request.delay_reason}. Financially locked (funded/paid) milestones were preserved."
    )
    summary_text = (
        f"Reschedule proposal prepared with {len(sanitized_adjustments)} task date adjustment(s) "
        f"(risk: {overall_risk}). Requires human authorization before updating schedule."
    )

    if has_groq_api_key() and sanitized_adjustments:
        try:
            adj_lines = "\n".join(
                f"- {a.task_name} ({a.task_id}): {a.previous_start_date}..{a.previous_end_date} -> "
                f"{a.proposed_start_date}..{a.proposed_end_date} ({a.delta_days:+d}d)"
                for a in sanitized_adjustments
            )
            prompt = (
                f"Project ID: {request.project_id}\n"
                f"Delay Days: {request.delay_days}\n"
                f"Delay Reason: {request.delay_reason}\n"
                f"Calculated Adjustments:\n{adj_lines}\n"
                f"Conflicts Detected: {len(all_conflicts)}"
            )
            llm_out, p_tok, c_tok, t_tok = await run_pydantic_agent(reschedule_pydantic_agent, prompt)
            prompt_tokens += p_tok
            completion_tokens += c_tok
            total_tokens += t_tok
            overall_risk = llm_out.overall_risk
            rationale = llm_out.rationale
            summary_text = llm_out.executive_summary
        except Exception as exc:
            logger.warning("Reschedule Agent LLM fallback triggered: %s", exc)

    proposal = SchedulingProposal(
        proposal_id=f"sprop-{uuid.uuid4().hex[:10]}",
        project_id=request.project_id,
        execution_id=execution_id,
        proposed_by_agent="reschedule_agent",
        status="pending_approval",
        overall_risk=overall_risk,
        total_delay_days=request.delay_days,
        rationale=rationale,
        adjustments=sanitized_adjustments,
        conflicts_resolved=all_conflicts,
        bryntum_tasks_preview=b_tasks,
        bryntum_dependencies_preview=b_deps,
        requires_human_approval=True,
    )

    response = RescheduleAgentResponse(
        project_id=request.project_id,
        delayed_task_id=request.delayed_task_id,
        affected_task_ids=[a.task_id for a in sanitized_adjustments],
        critical_path_impact_days=request.delay_days,
        conflicts_detected=all_conflicts,
        scheduling_proposal=proposal,
        summary=summary_text,
    )
    return response, tool_calls, prompt_tokens, completion_tokens, total_tokens
