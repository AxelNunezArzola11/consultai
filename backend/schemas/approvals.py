"""
Strict Pydantic Models for Approval Requests, Payment Proposals, Deterministic Policy Evaluations,
and Financial Risk Flags.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class FinancialRiskFlag(BaseModel):
    """Structured financial or compliance risk flag identified during payment evaluation."""

    code: str = Field(..., description="Machine-readable risk code (e.g., BUDGET_OVERRUN, UNVERIFIED_SHA, LOW_TRUST)")
    severity: Literal["low", "medium", "high", "critical"] = Field(default="medium")
    description: str = Field(..., description="Human-readable risk explanation")
    blocking: bool = Field(default=False, description="If True, deterministic policy blocks payout until resolved")


class PolicyEvaluationResult(BaseModel):
    """
    Stage 2: Deterministic Business-Rule Validation Result.
    Evaluated purely by deterministic Python policy rules, independent of LLM opinion.
    """

    passed: bool = Field(..., description="True only if all mandatory deterministic checks succeed")
    trust_score: int = Field(..., ge=0, le=100, description="Evaluated deliverable trust score")
    required_threshold: int = Field(default=75, ge=0, le=100, description="Minimum trust score required")
    all_objective_criteria_passed: bool = Field(..., description="True if all non-empty deliverable checks passed")
    head_sha_verified: bool = Field(default=True, description="True if commit SHA matches verified webhook/PR")
    budget_within_bounds: bool = Field(default=True, description="True if proposed amount <= remaining milestone budget")
    no_blocking_risk_flags: bool = Field(default=True, description="True if zero blocking FinancialRiskFlags exist")
    reasons: List[str] = Field(default_factory=list, description="Deterministic pass/fail reasons")
    evaluated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class PaymentProposalModel(BaseModel):
    """
    Stage 1 & 2 Financial Proposal prepared by the Finance Agent + Deterministic Policy Engine.
    NEVER executes a real transaction directly; requires Stage 3 Human Authorization.
    """

    proposal_id: str = Field(..., description="Unique payment proposal ID")
    execution_id: Optional[str] = Field(default=None, description="Originating multi-agent execution ID")
    project_id: str = Field(..., description="Project UUID")
    milestone_id: str = Field(..., description="Milestone UUID")
    milestone_title: Optional[str] = Field(default=None)
    recipient_email: str = Field(..., description="PayPal recipient email for the consultant")
    consultant_id: Optional[str] = Field(default=None)
    gross_amount_cents: int = Field(..., gt=0, description="Gross milestone payout amount in cents")
    platform_fee_cents: int = Field(..., ge=0, description="ConsultAI platform fee in cents (e.g., 15%)")
    net_amount_cents: int = Field(..., gt=0, description="Net payout to consultant in cents")
    currency: str = Field(default="USD", min_length=3, max_length=3)
    ai_eligibility_assessment: str = Field(
        ..., description="Finance Agent's structured explanation of payment eligibility"
    )
    ai_recommended_action: Literal["request_human_approval", "hold_for_remediation", "reject"] = Field(
        default="request_human_approval"
    )
    risk_flags: List[FinancialRiskFlag] = Field(default_factory=list)
    policy_evaluation: PolicyEvaluationResult = Field(
        ..., description="Deterministic business-rule validation result"
    )
    status: Literal[
        "pending_human_approval",
        "approved",
        "rejected",
        "executing_paypal",
        "paid",
        "failed",
    ] = Field(default="pending_human_approval")
    requires_human_authorization: bool = Field(
        default=True,
        description="Always True — AI is strictly prohibited from independently authorizing financial transfers",
    )
    authorized_by: Optional[str] = Field(default=None, description="Human actor who approved or rejected")
    authorized_at: Optional[str] = Field(default=None)
    paypal_batch_id: Optional[str] = Field(default=None, description="Real PayPal batch ID after confirmation")
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class ApprovalRequest(BaseModel):
    """
    Human-in-the-loop approval gate record for sensitive operations
    (Financial Payouts, Schedule Mutations, Contract Modifications).
    """

    approval_id: str = Field(..., description="Unique approval request ID")
    execution_id: str = Field(..., description="Associated orchestrator execution ID")
    project_id: Optional[str] = Field(default=None)
    milestone_id: Optional[str] = Field(default=None)
    operation_type: Literal["milestone_payout", "schedule_reschedule", "project_plan_baseline", "contract_release"] = (
        Field(...)
    )
    requested_by_agent: str = Field(..., description="Agent that raised the approval request")
    title: str = Field(..., description="Concise summary of what needs human authorization")
    summary: str = Field(..., description="Detailed operational context and impact")
    payload: Dict[str, Any] = Field(default_factory=dict, description="Structured proposal payload")
    policy_passed: bool = Field(default=True, description="Whether deterministic validation passed")
    status: Literal["pending", "approved", "rejected", "expired"] = Field(default="pending")
    decided_by: Optional[str] = Field(default=None)
    decided_role: Optional[Literal["company", "admin"]] = Field(default=None)
    decision_reason: Optional[str] = Field(default=None)
    decided_at: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
