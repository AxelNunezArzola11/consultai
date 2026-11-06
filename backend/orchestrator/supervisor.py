"""
Central Supervisor Agent Orchestrator.
Coordinates request classification, specialist agent delegation, context passing,
error recovery, persistent workflow state, and audit logging.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime

from backend.orchestrator.state import WorkflowGraphState, telemetry_registry
from backend.orchestrator.workflow import ClassifyRequestNode, supervisor_workflow_graph
from backend.schemas.requests import SupervisorRequest
from backend.schemas.responses import SupervisorResponse
from backend.services.audit import write_audit_record
from backend.services.persistence import get_idempotent_execution, save_execution_state

logger = logging.getLogger("consultai.orchestrator.supervisor")


class SupervisorOrchestrator:
    """Central Multi-Agent Supervisor coordinating all ConsultAI specialist agents."""

    async def execute(self, request: SupervisorRequest) -> SupervisorResponse:
        # 1. Check idempotency key if supplied
        existing = get_idempotent_execution(request.idempotency_key)
        if existing is not None:
            logger.info(
                "Returning idempotent SupervisorResponse execution_id=%s for key=%s",
                existing.execution_id,
                request.idempotency_key,
            )
            return existing

        execution_id = f"exec-{uuid.uuid4().hex[:12]}"
        t0 = datetime.utcnow()
        telemetry_registry.mark_started("supervisor_agent")

        state = WorkflowGraphState(
            execution_id=execution_id,
            request=request,
            started_at=t0,
        )

        try:
            response: SupervisorResponse = await supervisor_workflow_graph.run(
                inputs=ClassifyRequestNode(),
                state=state,
            )
            telemetry_registry.mark_finished(
                "supervisor_agent",
                duration_ms=response.duration_ms,
                tokens=response.total_tokens,
                success=response.status != "failed",
            )
        except Exception as exc:
            dur_ms = max(1, int((datetime.utcnow() - t0).total_seconds() * 1000))
            telemetry_registry.mark_finished(
                "supervisor_agent",
                duration_ms=dur_ms,
                tokens=0,
                success=False,
            )
            logger.exception("Unhandled error in SupervisorOrchestrator: %s", exc)
            raise

        # Persist execution state & audit log
        await save_execution_state(
            response,
            requested_by=request.actor_id,
            idempotency_key=request.idempotency_key,
        )
        await write_audit_record(
            actor=request.actor_id,
            action=f"orchestrator.{response.supervisor_decision.intent}",
            entity_type="agent_execution",
            entity_id=response.execution_id,
            payload={
                "delegated_agents": response.delegated_agents,
                "status": response.status,
                "approval_status": response.approval_status,
                "duration_ms": response.duration_ms,
                "total_tokens": response.total_tokens,
            },
        )
        return response


supervisor = SupervisorOrchestrator()
