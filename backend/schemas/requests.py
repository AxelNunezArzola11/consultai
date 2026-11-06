"""
Strict Pydantic Models for Orchestrator & Specialist Agent Requests.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

from backend.schemas.tasks import TaskState


OperationTypeLiteral = Literal[
    "auto",
    "project_planning",
    "talent_evaluation",
    "delivery_verification",
    "financial_assessment",
    "schedule_reschedule",
    "full_project_review",
]


class PlanningAgentRequest(BaseModel):
    """Input contract for the Planning Agent."""

    project_id: str = Field(default="proj-default", description="Project UUID")
    project_title: str = Field(..., min_length=2, description="Title of the consulting project")
    project_brief: str = Field(..., min_length=10, description="Scope, goals, and constraints of the project")
    total_budget_cents: int = Field(default=2500000, ge=0, description="Total project budget in cents")
    start_date: Optional[str] = Field(default=None, description="Target project start date (YYYY-MM-DD)")
    target_end_date: Optional[str] = Field(default=None, description="Target project completion date (YYYY-MM-DD)")
    existing_tasks: List[TaskState] = Field(default_factory=list)
    available_consultants: List[Dict[str, Any]] = Field(default_factory=list)


class TalentAgentRequest(BaseModel):
    """Input contract for the Talent Agent."""

    project_id: str = Field(default="proj-default")
    project_requirements: List[str] = Field(
        default_factory=list, description="Required technical skills and domain experience"
    )
    project_brief: str = Field(default="", description="Project brief for context")
    candidate_id: Optional[str] = Field(default=None)
    candidate_name: Optional[str] = Field(default=None)
    github_username: Optional[str] = Field(default=None, description="GitHub handle to inspect verified repositories")
    role_title: str = Field(default="Senior Consultant")
    candidates_pool: List[Dict[str, Any]] = Field(
        default_factory=list, description="Optional list of candidate profiles from DB to evaluate and rank"
    )


class DeliveryAgentRequest(BaseModel):
    """Input contract for the Delivery Agent."""

    project_id: str = Field(default="proj-default")
    milestone_id: str = Field(..., description="Milestone ID being evaluated")
    milestone_title: str = Field(default="Milestone Deliverable")
    acceptance_criteria: List[str] = Field(
        default_factory=list, description="Explicit acceptance criteria for the milestone"
    )
    pr_url: Optional[str] = Field(default=None, description="GitHub Pull Request URL")
    repository_full_name: Optional[str] = Field(default=None, description="owner/repo")
    pr_number: Optional[int] = Field(default=None)
    head_sha: Optional[str] = Field(default=None, description="Git commit SHA")
    pr_title: str = Field(default="")
    pr_body: str = Field(default="")
    diff_summary: str = Field(default="", description="Code diff or patch summary")
    changed_files: List[str] = Field(default_factory=list)
    ci_checks_passed: Optional[bool] = Field(default=None)


class FinanceAgentRequest(BaseModel):
    """Input contract for the Finance Agent."""

    project_id: str = Field(..., description="Project UUID")
    milestone_id: str = Field(..., description="Milestone UUID")
    milestone_title: str = Field(default="Project Milestone")
    recipient_email: str = Field(..., description="Consultant PayPal email")
    consultant_id: Optional[str] = Field(default=None)
    gross_amount_cents: int = Field(..., gt=0, description="Milestone payout amount in cents")
    project_total_budget_cents: int = Field(default=5000000, ge=0)
    project_already_paid_cents: int = Field(default=0, ge=0)
    currency: str = Field(default="USD")
    trust_score: int = Field(..., ge=0, le=100, description="Verified delivery trust score")
    all_criteria_passed: bool = Field(default=False, description="Whether all objective delivery criteria passed")
    head_sha_verified: bool = Field(default=True, description="Whether commit SHA was deterministically verified")
    delivery_summary: str = Field(default="", description="Summary from Delivery Agent")


class RescheduleAgentRequest(BaseModel):
    """Input contract for the Reschedule Agent."""

    project_id: str = Field(..., description="Project UUID")
    delayed_task_id: Optional[str] = Field(default=None, description="Specific task/milestone experiencing delay")
    delay_days: int = Field(default=3, description="Number of days delayed (or requested shift)")
    delay_reason: str = Field(default="Upstream deliverable slippage", description="Reason for schedule change")
    tasks: List[TaskState] = Field(default_factory=list, description="Current project tasks and milestones")


class SupervisorRequest(BaseModel):
    """
    Primary request payload for the Central Supervisor Agent.
    Can handle natural language instructions, structured agent payloads, or composite workflows.
    """

    user_request: str = Field(..., min_length=2, description="Natural language or operational request from user")
    operation_type: OperationTypeLiteral = Field(
        default="auto", description="Explicit operation type or 'auto' for Supervisor classification"
    )
    project_id: Optional[str] = Field(default=None, description="Target project ID")
    milestone_id: Optional[str] = Field(default=None, description="Target milestone ID")
    candidate_id: Optional[str] = Field(default=None, description="Target candidate ID")
    actor_role: Literal["company", "freelancer", "admin"] = Field(default="company")
    actor_id: str = Field(default="company-operator")
    context: Dict[str, Any] = Field(
        default_factory=dict,
        description="Structured context (tasks, candidate profile, PR metadata, budget info)",
    )
    idempotency_key: Optional[str] = Field(default=None, description="Optional client idempotency key")


class ApprovalDecisionRequest(BaseModel):
    """Human authorization decision payload for a pending execution or proposal."""

    approval_id: Optional[str] = Field(default=None)
    proposal_id: Optional[str] = Field(default=None)
    decision: Literal["approved", "rejected"] = Field(...)
    actor_id: str = Field(..., min_length=1, description="Authenticated human reviewer ID or email")
    actor_role: Literal["company", "admin"] = Field(default="company")
    reason: str = Field(default="Reviewed and authorized by operator", min_length=3)
