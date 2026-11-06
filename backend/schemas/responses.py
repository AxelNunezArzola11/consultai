"""
Strict Pydantic Models for Specialist Agent Responses, Supervisor Outputs,
Tool Call Records, Agent Handoffs, and Execution Errors.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

from backend.schemas.approvals import ApprovalRequest, PaymentProposalModel
from backend.schemas.tasks import (
    BryntumAssignmentNode,
    BryntumDependencyNode,
    BryntumResourceNode,
    BryntumTaskNode,
    ProjectRiskItem,
    SchedulingConflict,
    SchedulingProposal,
    TaskState,
)


class AgentExecutionError(BaseModel):
    """Structured error captured during agent execution or tool invocation."""

    error_code: str = Field(..., description="Standardized error code")
    agent_name: str = Field(..., description="Agent where the error occurred")
    message: str = Field(..., description="Safe operational error description")
    recoverable: bool = Field(default=True)
    retry_attempt: int = Field(default=0)
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class ToolCallRecord(BaseModel):
    """Audit record of a deterministic tool call invoked during an agent execution."""

    tool_name: str = Field(..., description="Name of the tool invoked")
    agent_name: str = Field(..., description="Agent that invoked the tool")
    inputs_summary: Dict[str, Any] = Field(default_factory=dict)
    output_summary: str = Field(..., description="Concise summary of deterministic tool output")
    status: Literal["success", "error", "skipped"] = Field(default="success")
    duration_ms: int = Field(default=0, ge=0)
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class AgentHandoff(BaseModel):
    """Structured handoff record tracking delegation between Supervisor and Specialist Agents."""

    handoff_id: str = Field(..., description="Unique handoff identifier")
    from_agent: str = Field(default="supervisor_agent")
    to_agent: str = Field(..., description="Target specialist agent")
    reason: str = Field(..., description="Why the Supervisor delegated to this specialist")
    context_keys: List[str] = Field(default_factory=list, description="Context keys passed to the specialist")
    status: Literal["pending", "running", "completed", "failed"] = Field(default="completed")
    duration_ms: int = Field(default=0, ge=0)
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class PlanningAgentResponse(BaseModel):
    """Structured output produced by the Planning Agent."""

    project_id: str
    summary: str = Field(..., description="Executive summary of the generated project plan")
    estimated_total_duration_days: int = Field(default=14, ge=1)
    critical_path_task_ids: List[str] = Field(default_factory=list)
    tasks: List[TaskState] = Field(default_factory=list)
    bryntum_tasks: List[BryntumTaskNode] = Field(default_factory=list)
    bryntum_dependencies: List[BryntumDependencyNode] = Field(default_factory=list)
    bryntum_resources: List[BryntumResourceNode] = Field(default_factory=list)
    bryntum_assignments: List[BryntumAssignmentNode] = Field(default_factory=list)
    risks: List[ProjectRiskItem] = Field(default_factory=list)
    scheduling_proposal: Optional[SchedulingProposal] = None
    requires_human_approval: bool = Field(
        default=True, description="True because applying a new baseline schedule requires human authorization"
    )


class CandidateGitHubEvidence(BaseModel):
    """Verified GitHub repository evidence for a candidate (never fabricated)."""

    repo_name: str
    repo_url: str
    primary_language: Optional[str] = None
    stars: int = Field(default=0, ge=0)
    description: Optional[str] = None
    verified_via_api: bool = Field(
        default=False, description="True only when fetched directly from live GitHub API"
    )


class CandidateRecommendation(BaseModel):
    """Structured evaluation for a single consultant candidate."""

    candidate_id: str
    name: str
    role: str
    github_username: Optional[str] = None
    overall_fit_score: int = Field(..., ge=0, le=100)
    skill_match_score: int = Field(..., ge=0, le=100)
    availability_status: Literal["available", "partially_allocated", "unavailable"] = Field(default="available")
    verification_source: Literal["github_live_api", "database_verified_signals", "unverified_profile_only"] = Field(
        default="database_verified_signals"
    )
    matched_skills: List[str] = Field(default_factory=list)
    missing_skills: List[str] = Field(default_factory=list)
    can_do: List[str] = Field(default_factory=list, description="Capabilities backed by verified evidence")
    cannot_do: List[str] = Field(default_factory=list, description="Gaps or unverified requirements")
    verified_evidence: List[CandidateGitHubEvidence] = Field(default_factory=list)
    recommendation_rationale: str = Field(..., description="Evidence-based rationale")


class TalentAgentResponse(BaseModel):
    """Structured output produced by the Talent Agent."""

    project_id: str
    evaluated_count: int = Field(default=0, ge=0)
    top_candidate_id: Optional[str] = None
    recommendations: List[CandidateRecommendation] = Field(default_factory=list)
    verification_disclaimer: str = Field(
        default="All verification flags reflect deterministic GitHub API or database evidence. Unverified claims are explicitly marked."
    )
    summary: str


class CriterionEvaluation(BaseModel):
    """Evaluation of a single deliverable acceptance criterion."""

    criterion: str
    status: Literal["passed", "failed", "incomplete", "unverified"]
    evidence_type: Literal["verified_deterministic", "ai_code_review", "missing_evidence"]
    explanation: str


class DeliveryAgentResponse(BaseModel):
    """Structured output produced by the Delivery Agent."""

    project_id: str
    milestone_id: str
    trust_score: int = Field(..., ge=0, le=100, description="Overall deliverable trust score (0-100)")
    verdict: Literal["approved_for_payout_review", "needs_remediation", "rejected"] = Field(...)
    verified_evidence_items: List[str] = Field(
        default_factory=list,
        description="Facts deterministically verified via GitHub API, commit SHA, or CI status",
    )
    ai_assessment_items: List[str] = Field(
        default_factory=list,
        description="Advisory code quality and criteria assessments generated by AI analysis",
    )
    criteria_evaluations: List[CriterionEvaluation] = Field(default_factory=list)
    incomplete_work_items: List[str] = Field(default_factory=list)
    security_or_quality_warnings: List[str] = Field(default_factory=list)
    summary: str


class FinanceAgentResponse(BaseModel):
    """Structured output produced by the Finance Agent."""

    project_id: str
    milestone_id: str
    eligible_for_proposal: bool = Field(
        ..., description="True if deterministic policy checks allow raising a human approval request"
    )
    payment_proposal: PaymentProposalModel
    summary: str


class RescheduleAgentResponse(BaseModel):
    """Structured output produced by the Reschedule Agent."""

    project_id: str
    delayed_task_id: Optional[str] = None
    affected_task_ids: List[str] = Field(default_factory=list)
    critical_path_impact_days: int = Field(default=0)
    conflicts_detected: List[SchedulingConflict] = Field(default_factory=list)
    scheduling_proposal: SchedulingProposal
    summary: str


class SupervisorClassification(BaseModel):
    """Supervisor Agent's classification of the user's request and planned delegation chain."""

    intent: Literal[
        "project_planning",
        "talent_evaluation",
        "delivery_verification",
        "financial_assessment",
        "schedule_reschedule",
        "full_project_review",
    ]
    selected_agents: List[
        Literal["planning_agent", "talent_agent", "delivery_agent", "finance_agent", "reschedule_agent"]
    ]
    requires_human_approval: bool = Field(default=False)
    decision_rationale: str = Field(
        ..., description="Concise operational explanation of why these specialist agents were selected"
    )


class SupervisorResponse(BaseModel):
    """Complete response returned by the Central Supervisor Agent."""

    execution_id: str = Field(..., description="Unique execution tracking ID")
    project_id: Optional[str] = None
    user_request: str
    status: Literal["running", "awaiting_human_approval", "completed", "failed"]
    approval_status: Literal["not_required", "pending", "approved", "rejected"] = Field(default="not_required")
    supervisor_decision: SupervisorClassification
    delegated_agents: List[str] = Field(default_factory=list)
    handoffs: List[AgentHandoff] = Field(default_factory=list)
    tool_calls: List[ToolCallRecord] = Field(default_factory=list)
    structured_outputs: Dict[str, Any] = Field(default_factory=dict)
    pending_approvals: List[ApprovalRequest] = Field(default_factory=list)
    payment_proposals: List[PaymentProposalModel] = Field(default_factory=list)
    scheduling_proposals: List[SchedulingProposal] = Field(default_factory=list)
    errors: List[AgentExecutionError] = Field(default_factory=list)
    retry_count: int = Field(default=0, ge=0)
    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)
    duration_ms: int = Field(default=0, ge=0)
    final_result: str = Field(..., description="Synthesized operational summary for the user")
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
