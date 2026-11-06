"""
FastAPI Router for Multi-Agent Orchestration, Specialist Agent Endpoints,
Human Approval Gate Decisions, and AI Operations Center SSE Streaming.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from backend.agents.delivery import execute_delivery_agent
from backend.agents.finance import execute_finance_agent
from backend.agents.planning import execute_planning_agent
from backend.agents.reschedule import execute_reschedule_agent
from backend.agents.talent import execute_talent_agent
from backend.orchestrator.state import telemetry_registry
from backend.orchestrator.supervisor import supervisor
from backend.policies.permissions import (
    AuthenticatedActor,
    require_human_authorization_actor,
    require_permission,
    resolve_actor_from_request,
)
from backend.schemas.requests import (
    ApprovalDecisionRequest,
    DeliveryAgentRequest,
    FinanceAgentRequest,
    PlanningAgentRequest,
    RescheduleAgentRequest,
    SupervisorRequest,
    TalentAgentRequest,
)
from backend.schemas.responses import (
    DeliveryAgentResponse,
    FinanceAgentResponse,
    PlanningAgentResponse,
    RescheduleAgentResponse,
    SupervisorResponse,
    TalentAgentResponse,
)
from backend.services.audit import list_recent_audit_logs, write_audit_record
from backend.services.notifications import broadcaster
from backend.services.persistence import (
    get_execution_by_id,
    list_executions,
    update_execution_approval,
)

logger = logging.getLogger("consultai.orchestrator.router")

router = APIRouter(tags=["Multi-Agent Orchestrator & AI Operations Center"])


@router.post(
    "/api/orchestrator/execute",
    response_model=SupervisorResponse,
    summary="Execute Central Supervisor Agent Multi-Agent Workflow",
)
async def execute_supervisor_endpoint(
    payload: SupervisorRequest,
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> SupervisorResponse:
    require_permission(actor, "orchestrator:execute")
    payload.actor_role = actor.role
    payload.actor_id = actor.actor_id
    return await supervisor.execute(payload)


@router.get(
    "/api/orchestrator/executions",
    summary="List Multi-Agent Executions for AI Operations Center & AG Grid",
)
async def list_executions_endpoint(
    limit: int = Query(default=50, ge=1, le=200),
    project_id: Optional[str] = Query(default=None),
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> Dict[str, Any]:
    require_permission(actor, "orchestrator:read")
    executions = await list_executions(limit=limit, project_id=project_id)
    agents_status = [m.model_dump() for m in telemetry_registry.list_status()]
    return {
        "executions": executions,
        "agents": agents_status,
        "count": len(executions),
    }


@router.get(
    "/api/orchestrator/executions/{execution_id}",
    summary="Get Full Execution Detail View",
)
async def get_execution_detail_endpoint(
    execution_id: str,
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> Dict[str, Any]:
    require_permission(actor, "orchestrator:read")
    detail = await get_execution_by_id(execution_id)
    if not detail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Execution '{execution_id}' not found.",
        )
    return detail


@router.post(
    "/api/orchestrator/executions/{execution_id}/approve",
    summary="Human Authorization Gate for Pending Financial or Schedule Proposals",
)
async def approve_execution_endpoint(
    execution_id: str,
    decision_req: ApprovalDecisionRequest,
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> Dict[str, Any]:
    # Enforce strict human authorization policy (AI cannot authorize)
    require_human_authorization_actor(decision_req.actor_id, decision_req.actor_role)

    updated = await update_execution_approval(
        execution_id=execution_id,
        decision=decision_req.decision,
        actor_id=decision_req.actor_id,
        reason=decision_req.reason,
    )
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Execution '{execution_id}' not found.",
        )

    await write_audit_record(
        actor=decision_req.actor_id,
        action=f"orchestrator.execution.{decision_req.decision}",
        entity_type="agent_execution",
        entity_id=execution_id,
        payload={
            "decision": decision_req.decision,
            "actor_role": decision_req.actor_role,
            "reason": decision_req.reason,
        },
    )

    await broadcaster.publish(
        "execution_approval_decided",
        {
            "execution_id": execution_id,
            "decision": decision_req.decision,
            "decided_by": decision_req.actor_id,
            "reason": decision_req.reason,
        },
    )
    return updated


@router.get(
    "/api/orchestrator/agents/status",
    summary="Live Agent Availability, Telemetry & Audit Summary",
)
async def get_agents_status_endpoint(
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> Dict[str, Any]:
    require_permission(actor, "orchestrator:read")
    agents = [m.model_dump() for m in telemetry_registry.list_status()]
    recent_executions = await list_executions(limit=25)
    recent_audits = await list_recent_audit_logs(limit=20)
    return {
        "agents": agents,
        "active_workflows": sum(a["active_executions"] for a in agents),
        "recent_executions": recent_executions,
        "recent_audits": recent_audits,
    }


@router.get(
    "/api/orchestrator/stream",
    summary="Server-Sent Events (SSE) Live Operational Stream for AI Operations Center",
)
async def stream_orchestrator_events() -> StreamingResponse:
    return StreamingResponse(
        broadcaster.subscribe(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# Direct Specialist Agent Endpoints for Targeted Invocations
@router.post("/api/agents/planning", response_model=PlanningAgentResponse)
async def run_planning_specialist(
    req: PlanningAgentRequest,
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> PlanningAgentResponse:
    require_permission(actor, "planning:propose")
    resp, _, _, _, _ = await execute_planning_agent(req)
    return resp


@router.post("/api/agents/talent", response_model=TalentAgentResponse)
async def run_talent_specialist(
    req: TalentAgentRequest,
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> TalentAgentResponse:
    require_permission(actor, "talent:evaluate")
    resp, _, _, _, _ = await execute_talent_agent(req)
    return resp


@router.post("/api/agents/delivery", response_model=DeliveryAgentResponse)
async def run_delivery_specialist(
    req: DeliveryAgentRequest,
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> DeliveryAgentResponse:
    require_permission(actor, "delivery:verify")
    resp, _, _, _, _ = await execute_delivery_agent(req)
    return resp


@router.post("/api/agents/finance", response_model=FinanceAgentResponse)
async def run_finance_specialist(
    req: FinanceAgentRequest,
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> FinanceAgentResponse:
    require_permission(actor, "finance:propose")
    resp, _, _, _, _ = await execute_finance_agent(req)
    return resp


@router.post("/api/agents/reschedule", response_model=RescheduleAgentResponse)
async def run_reschedule_specialist(
    req: RescheduleAgentRequest,
    actor: AuthenticatedActor = Depends(resolve_actor_from_request),
) -> RescheduleAgentResponse:
    require_permission(actor, "planning:propose")
    resp, _, _, _, _ = await execute_reschedule_agent(req)
    return resp
