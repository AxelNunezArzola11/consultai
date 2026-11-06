"""
Backward-compatible Pydantic models module (`backend.models`) + extended fields for
Section 5 Financial & Security Policy enforcement.
"""
from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class GitHubRepoPayload(BaseModel):
    full_name: str = Field(..., description="Full repository name, e.g., owner/repo")
    html_url: str = Field(..., description="URL to the repository")


class GitHubPullRequestPayload(BaseModel):
    number: int
    title: str
    body: Optional[str] = ""
    html_url: str
    diff_url: str
    state: str
    merged: bool = False


class GitHubWebhookPayload(BaseModel):
    action: str
    pull_request: Optional[GitHubPullRequestPayload] = None
    repository: GitHubRepoPayload


class PRVerificationResult(BaseModel):
    trust_score: int = Field(
        ...,
        ge=0,
        le=100,
        description="Confidence score from 0 to 100 that the PR satisfies milestone deliverables",
    )
    verdict: Literal["approved", "needs_work", "rejected"]
    summary: str = Field(..., description="Concise executive summary of the code review")
    strengths: List[str] = Field(default_factory=list)
    blocking_issues: List[str] = Field(default_factory=list)
    recommended_payout_percentage: int = Field(..., ge=0, le=100)


class CandidateVettingResult(BaseModel):
    github_username: str
    role_target: str
    trust_score: int = Field(..., ge=0, le=100)
    can_do: List[str] = Field(
        default_factory=list,
        description="Verified skills and capabilities backed by repository evidence",
    )
    cannot_do: List[str] = Field(
        default_factory=list,
        description="Required skills or domains lacking evidence or failing quality bar",
    )
    summary: str


class MilestoneNode(BaseModel):
    id: str
    name: str
    start_date: str = Field(..., description="ISO-8601 date string YYYY-MM-DD")
    end_date: str = Field(..., description="ISO-8601 date string YYYY-MM-DD")
    dependencies: List[str] = Field(default_factory=list)
    status: Literal["pending", "in_progress", "completed", "delayed", "funded", "paid"] = "pending"


class GanttMutationPayload(BaseModel):
    project_id: str
    updated_milestones: List[MilestoneNode]
    critical_path_shift_days: int
    reason: str
    requires_human_approval: bool = True


class ThresholdCheckRequest(BaseModel):
    milestone_id: str
    recipient_email: str
    amount: float = Field(..., gt=0, description="Payout amount in USD")
    currency: str = Field(default="USD", min_length=3, max_length=3)
    trust_score: int = Field(..., ge=0, le=100)
    threshold: int = Field(default=80, ge=0, le=100)
    # Stage 3 Human Authorization fields required before executing an actual PayPal transfer:
    approval_id: Optional[str] = Field(
        default=None,
        description="Verified human approval ID. If omitted, endpoint returns a PaymentProposal awaiting human authorization.",
    )
    authorized_by: Optional[str] = Field(
        default=None,
        description="Authenticated human actor who approved the payout (AI cannot authorize).",
    )
    actor_role: Literal["company", "admin"] = Field(default="company")


class ThresholdCheckResponse(BaseModel):
    milestone_id: str
    trust_score: int
    threshold_met: bool
    payout_released: bool
    payout_batch_id: Optional[str] = None
    proposal_id: Optional[str] = None
    requires_human_authorization: bool = True
    status: Literal[
        "below_threshold",
        "awaiting_human_authorization",
        "payout_released",
    ] = "awaiting_human_authorization"
    message: str
