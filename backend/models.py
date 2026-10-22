from __future__ import annotations

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class VettingStatus(str, Enum):
    APPROVED = "approved"
    REJECTED = "rejected"
    NEEDS_REVIEW = "needs_review"


class CandidateVettingResult(BaseModel):
    """Structured output from AI vetting of a candidate code submission."""

    candidate_id: str = Field(..., description="Unique identifier for the candidate")
    pr_number: int = Field(..., description="GitHub pull request number that was analyzed")
    trust_score: float = Field(
        ..., ge=0.0, le=100.0, description="Computed trust score from 0 to 100"
    )
    status: VettingStatus = Field(..., description="Overall vetting status determination")
    code_quality_summary: str = Field(
        ..., description="Brief summary of code quality observations"
    )
    security_flags: list[str] = Field(
        default_factory=list, description="List of identified security concerns, if any"
    )
    test_coverage_estimate: Optional[float] = Field(
        None, ge=0.0, le=100.0, description="Estimated unit test coverage percentage"
    )
    recommendations: list[str] = Field(
        default_factory=list,
        description="Actionable recommendations for the candidate",
    )


class MilestoneStatus(str, Enum):
    PENDING = "pending"
    THRESHOLD_MET = "threshold_met"
    PAYOUT_RELEASED = "payout_released"
    FAILED = "failed"


class MilestonePayoutCheck(BaseModel):
    """Result of evaluating whether a milestone payout threshold has been met."""

    milestone_id: str = Field(..., description="Unique identifier for the milestone")
    candidate_id: str = Field(..., description="Candidate associated with the milestone")
    budget_usd: float = Field(..., gt=0.0, description="Milestone budget in USD")
    trust_score: float = Field(..., ge=0.0, le=100.0, description="Current trust score")
    tests_passing: bool = Field(
        ..., description="Whether all unit tests are currently passing"
    )
    threshold_met: bool = Field(
        ...,
        description="True when trust_score >= 75 and tests_passing is True",
    )
    status: MilestoneStatus = Field(..., description="Current milestone payout status")
    paypal_payout_batch_id: Optional[str] = Field(
        None, description="PayPal payout batch ID if payout was released"
    )
    reason: str = Field(..., description="Human-readable explanation of the status")


class RescheduleRisk(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class MilestoneAdjustment(BaseModel):
    milestone_id: str
    original_due_date: str = Field(..., description="ISO-8601 date string")
    proposed_due_date: str = Field(..., description="ISO-8601 date string")
    rationale: str


class TimelineReschedulePlan(BaseModel):
    """AI-generated plan for rescheduling project milestones based on current progress."""

    project_id: str = Field(..., description="Unique project identifier")
    overall_risk: RescheduleRisk = Field(
        ..., description="Overall delivery risk assessment"
    )
    delay_days: int = Field(
        ..., ge=0, description="Estimated total delay in calendar days"
    )
    adjustments: list[MilestoneAdjustment] = Field(
        default_factory=list, description="Per-milestone schedule adjustments"
    )
    executive_summary: str = Field(
        ..., description="One-paragraph executive summary of the reschedule plan"
    )
    blockers: list[str] = Field(
        default_factory=list, description="Key blockers causing the delay"
    )
