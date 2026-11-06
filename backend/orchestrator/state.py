"""
Execution State and Agent Availability Registry for the AI Operations Center.
Tracks real runtime metrics (active executions, total runs, token usage, average duration,
and error counts) per agent without fabricating statuses or fake metrics.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

from backend.agents._llm import DEFAULT_GROQ_MODEL, has_groq_api_key
from backend.schemas.approvals import ApprovalRequest, PaymentProposalModel
from backend.schemas.requests import SupervisorRequest
from backend.schemas.responses import (
    AgentExecutionError,
    AgentHandoff,
    SupervisorClassification,
    ToolCallRecord,
)
from backend.schemas.tasks import SchedulingProposal


class AgentAvailabilityMetric(BaseModel):
    """Real operational telemetry for an individual agent in the multi-agent architecture."""

    agent_id: str
    display_name: str
    role_description: str
    status: Literal["ready", "busy", "degraded"] = Field(default="ready")
    llm_configured: bool = Field(default=True)
    model_name: str = Field(default=DEFAULT_GROQ_MODEL)
    active_executions: int = Field(default=0, ge=0)
    total_executions: int = Field(default=0, ge=0)
    successful_executions: int = Field(default=0, ge=0)
    failed_executions: int = Field(default=0, ge=0)
    total_tokens_consumed: int = Field(default=0, ge=0)
    avg_duration_ms: int = Field(default=0, ge=0)
    last_active_at: Optional[str] = None


@dataclass
class WorkflowGraphState:
    """Mutable state passed across `pydantic_graph` nodes during a Supervisor execution."""

    execution_id: str
    request: SupervisorRequest
    started_at: datetime = field(default_factory=datetime.utcnow)
    db_context: Dict[str, Any] = field(default_factory=dict)
    classification: Optional[SupervisorClassification] = None
    delegated_agents: List[str] = field(default_factory=list)
    handoffs: List[AgentHandoff] = field(default_factory=list)
    tool_calls: List[ToolCallRecord] = field(default_factory=list)
    structured_outputs: Dict[str, Any] = field(default_factory=dict)
    pending_approvals: List[ApprovalRequest] = field(default_factory=list)
    payment_proposals: List[PaymentProposalModel] = field(default_factory=list)
    scheduling_proposals: List[SchedulingProposal] = field(default_factory=list)
    errors: List[AgentExecutionError] = field(default_factory=list)
    retry_count: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    status: Literal["running", "awaiting_human_approval", "completed", "failed"] = "running"
    approval_status: Literal["not_required", "pending", "approved", "rejected"] = "not_required"
    final_result: str = ""


class AgentTelemetryRegistry:
    """Tracks real in-process execution metrics per specialist agent."""

    def __init__(self) -> None:
        self._agents: Dict[str, AgentAvailabilityMetric] = {
            "supervisor_agent": AgentAvailabilityMetric(
                agent_id="supervisor_agent",
                display_name="Supervisor Orchestrator",
                role_description="Central classifier, context router, policy enforcer, and human approval gatekeeper.",
            ),
            "planning_agent": AgentAvailabilityMetric(
                agent_id="planning_agent",
                display_name="Planning Agent",
                role_description="Generates project plans, WBS breakdowns, critical path, risks, and Bryntum Gantt structures.",
            ),
            "talent_agent": AgentAvailabilityMetric(
                agent_id="talent_agent",
                display_name="Talent Vetting Agent",
                role_description="Evaluates consultant profiles and verifies real GitHub repositories against project skills.",
            ),
            "delivery_agent": AgentAvailabilityMetric(
                agent_id="delivery_agent",
                display_name="Delivery Verification Agent",
                role_description="Audits GitHub PRs, commit SHAs, acceptance criteria, and deliverable completeness.",
            ),
            "finance_agent": AgentAvailabilityMetric(
                agent_id="finance_agent",
                display_name="Finance & Escrow Agent",
                role_description="Calculates milestone fee breakdowns, runs deterministic payout policies, and prepares payment proposals.",
            ),
            "reschedule_agent": AgentAvailabilityMetric(
                agent_id="reschedule_agent",
                display_name="Reschedule & Critical Path Agent",
                role_description="Analyzes delays, propagates Finish-to-Start shifts, detects conflicts, and proposes new Bryntum dates.",
            ),
        }

    def mark_started(self, agent_id: str) -> None:
        metric = self._agents.get(agent_id)
        if not metric:
            return
        metric.active_executions += 1
        metric.status = "busy"
        metric.llm_configured = has_groq_api_key()
        metric.last_active_at = datetime.utcnow().isoformat()

    def mark_finished(
        self,
        agent_id: str,
        *,
        duration_ms: int,
        tokens: int = 0,
        success: bool = True,
    ) -> None:
        metric = self._agents.get(agent_id)
        if not metric:
            return
        metric.active_executions = max(0, metric.active_executions - 1)
        metric.total_executions += 1
        if success:
            metric.successful_executions += 1
        else:
            metric.failed_executions += 1
        metric.total_tokens_consumed += max(0, tokens)
        prev_total = metric.total_executions - 1
        metric.avg_duration_ms = int(
            ((metric.avg_duration_ms * prev_total) + max(1, duration_ms)) / metric.total_executions
        )
        metric.status = "busy" if metric.active_executions > 0 else "ready"
        metric.llm_configured = has_groq_api_key()
        metric.last_active_at = datetime.utcnow().isoformat()

    def list_status(self) -> List[AgentAvailabilityMetric]:
        llm_ok = has_groq_api_key()
        for m in self._agents.values():
            m.llm_configured = llm_ok
        return list(self._agents.values())


telemetry_registry = AgentTelemetryRegistry()
