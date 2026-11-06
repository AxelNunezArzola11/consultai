"""
Database-Backed Workflow State and Execution History Persistence Service.
Persists Supervisor executions, Scheduling Proposals, Payment Proposals, and Approval Requests
into the shared Neon PostgreSQL database.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from backend.schemas.approvals import ApprovalRequest, PaymentProposalModel
from backend.schemas.responses import SupervisorResponse
from backend.schemas.tasks import SchedulingProposal
from backend.tools.database import init_db_pool

logger = logging.getLogger("consultai.services.persistence")

# In-process mirror for immediate lookup and fallback when local DATABASE_URL is unset
_executions_store: Dict[str, SupervisorResponse] = {}
_approvals_store: Dict[str, ApprovalRequest] = {}
_payment_proposals_store: Dict[str, PaymentProposalModel] = {}
_scheduling_proposals_store: Dict[str, SchedulingProposal] = {}
_idempotency_map: Dict[str, str] = {}


def get_idempotent_execution(idempotency_key: Optional[str]) -> Optional[SupervisorResponse]:
    if not idempotency_key:
        return None
    exec_id = _idempotency_map.get(idempotency_key)
    if exec_id and exec_id in _executions_store:
        return _executions_store[exec_id]
    return None


async def save_execution_state(
    response: SupervisorResponse,
    *,
    requested_by: str = "company-operator",
    idempotency_key: Optional[str] = None,
) -> None:
    """Persists a SupervisorResponse and any nested proposals/approvals to Neon PostgreSQL."""
    _executions_store[response.execution_id] = response
    if idempotency_key:
        _idempotency_map[idempotency_key] = response.execution_id

    for app in response.pending_approvals:
        _approvals_store[app.approval_id] = app
    for pp in response.payment_proposals:
        _payment_proposals_store[pp.proposal_id] = pp
    for sp in response.scheduling_proposals:
        _scheduling_proposals_store[sp.proposal_id] = sp

    pool = await init_db_pool()
    if pool is None:
        return

    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO agent_executions (
                    id, project_id, user_request, intent, supervisor_decision,
                    delegated_agents, handoffs, status, approval_status,
                    structured_outputs, tool_calls, errors, retry_count,
                    prompt_tokens, completion_tokens, total_tokens, duration_ms,
                    final_result, requested_by, created_at, updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5::jsonb,
                    $6::jsonb, $7::jsonb, $8, $9,
                    $10::jsonb, $11::jsonb, $12::jsonb, $13,
                    $14, $15, $16, $17,
                    $18, $19, NOW(), NOW()
                )
                ON CONFLICT (id) DO UPDATE SET
                    status = EXCLUDED.status,
                    approval_status = EXCLUDED.approval_status,
                    structured_outputs = EXCLUDED.structured_outputs,
                    tool_calls = EXCLUDED.tool_calls,
                    errors = EXCLUDED.errors,
                    retry_count = EXCLUDED.retry_count,
                    prompt_tokens = EXCLUDED.prompt_tokens,
                    completion_tokens = EXCLUDED.completion_tokens,
                    total_tokens = EXCLUDED.total_tokens,
                    duration_ms = EXCLUDED.duration_ms,
                    final_result = EXCLUDED.final_result,
                    updated_at = NOW()
                """,
                response.execution_id,
                response.project_id,
                response.user_request,
                response.supervisor_decision.intent,
                json.dumps(response.supervisor_decision.model_dump()),
                json.dumps(response.delegated_agents),
                json.dumps([h.model_dump() for h in response.handoffs]),
                response.status,
                response.approval_status,
                json.dumps(response.structured_outputs),
                json.dumps([tc.model_dump() for tc in response.tool_calls]),
                json.dumps([err.model_dump() for err in response.errors]),
                response.retry_count,
                response.prompt_tokens,
                response.completion_tokens,
                response.total_tokens,
                response.duration_ms,
                response.final_result,
                requested_by,
            )

            # Persist scheduling proposals if any
            for sp in response.scheduling_proposals:
                await conn.execute(
                    """
                    INSERT INTO scheduling_proposals (
                        id, project_id, execution_id, proposed_by_agent, overall_risk,
                        total_delay_days, rationale, adjustments, conflicts, status,
                        created_at, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, NOW(), NOW())
                    ON CONFLICT (id) DO UPDATE SET
                        status = EXCLUDED.status,
                        updated_at = NOW()
                    """,
                    sp.proposal_id,
                    sp.project_id,
                    response.execution_id,
                    sp.proposed_by_agent,
                    sp.overall_risk,
                    sp.total_delay_days,
                    sp.rationale,
                    json.dumps([a.model_dump() for a in sp.adjustments]),
                    json.dumps([c.model_dump() for c in sp.conflicts_resolved]),
                    sp.status,
                )
    except Exception as exc:
        logger.warning("Failed to persist execution %s to Neon DB: %s", response.execution_id, exc)


async def get_execution_by_id(execution_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves full execution detail by ID from Neon PostgreSQL or memory store."""
    if execution_id in _executions_store:
        return _executions_store[execution_id].model_dump()

    pool = await init_db_pool()
    if pool is None:
        return None

    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM agent_executions WHERE id = $1",
                execution_id,
            )
            if not row:
                return None
            return _normalize_db_execution_row(dict(row))
    except Exception as exc:
        logger.warning("Error reading execution %s from DB: %s", execution_id, exc)
        return None


async def list_executions(limit: int = 50, project_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Lists recent multi-agent executions from Neon PostgreSQL merged with in-memory active executions."""
    pool = await init_db_pool()
    db_rows: List[Dict[str, Any]] = []
    if pool is not None:
        try:
            async with pool.acquire() as conn:
                if project_id:
                    rows = await conn.fetch(
                        "SELECT * FROM agent_executions WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2",
                        project_id,
                        limit,
                    )
                else:
                    rows = await conn.fetch(
                        "SELECT * FROM agent_executions ORDER BY created_at DESC LIMIT $1",
                        limit,
                    )
                db_rows = [_normalize_db_execution_row(dict(r)) for r in rows]
        except Exception as exc:
            logger.warning("Error listing agent_executions from DB: %s", exc)

    seen_ids = {r["execution_id"] for r in db_rows}
    for exec_id, mem_item in sorted(
        _executions_store.items(), key=lambda kv: kv[1].created_at, reverse=True
    ):
        if exec_id not in seen_ids:
            if not project_id or mem_item.project_id == project_id:
                db_rows.insert(0, mem_item.model_dump())

    return db_rows[:limit]


async def update_execution_approval(
    *,
    execution_id: str,
    decision: str,
    actor_id: str,
    reason: str,
) -> Optional[Dict[str, Any]]:
    """Updates an execution's approval status after human review."""
    new_approval_status = "approved" if decision == "approved" else "rejected"
    new_exec_status = "completed" if decision == "approved" else "failed"

    if execution_id in _executions_store:
        exec_obj = _executions_store[execution_id]
        exec_obj.approval_status = new_approval_status  # type: ignore[assignment]
        exec_obj.status = new_exec_status  # type: ignore[assignment]
        for app in exec_obj.pending_approvals:
            app.status = new_approval_status  # type: ignore[assignment]
            app.decided_by = actor_id
            app.decision_reason = reason
            app.decided_at = datetime.utcnow().isoformat()
        for pp in exec_obj.payment_proposals:
            pp.status = "approved" if decision == "approved" else "rejected"  # type: ignore[assignment]
            pp.authorized_by = actor_id
            pp.authorized_at = datetime.utcnow().isoformat()
        for sp in exec_obj.scheduling_proposals:
            sp.status = "approved" if decision == "approved" else "rejected"  # type: ignore[assignment]

    pool = await init_db_pool()
    if pool is not None:
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE agent_executions
                    SET status = $2,
                        approval_status = $3,
                        decided_by = $4,
                        decided_at = NOW(),
                        updated_at = NOW()
                    WHERE id = $1
                    """,
                    execution_id,
                    new_exec_status,
                    new_approval_status,
                    actor_id,
                )
                await conn.execute(
                    """
                    UPDATE scheduling_proposals
                    SET status = $2,
                        decided_by = $3,
                        decided_at = NOW(),
                        updated_at = NOW()
                    WHERE execution_id = $1
                    """,
                    execution_id,
                    new_approval_status,
                    actor_id,
                )
        except Exception as exc:
            logger.warning("Failed to update execution approval in DB: %s", exc)

    return await get_execution_by_id(execution_id)


def _normalize_db_execution_row(row: Dict[str, Any]) -> Dict[str, Any]:
    for json_col in (
        "supervisor_decision",
        "delegated_agents",
        "handoffs",
        "structured_outputs",
        "tool_calls",
        "errors",
    ):
        val = row.get(json_col)
        if isinstance(val, str):
            try:
                row[json_col] = json.loads(val)
            except Exception:
                pass
    for dt_col in ("created_at", "updated_at", "decided_at"):
        val = row.get(dt_col)
        if isinstance(val, datetime):
            row[dt_col] = val.isoformat()
    row["execution_id"] = row.get("id")
    return row
