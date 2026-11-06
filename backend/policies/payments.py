"""
Section 5 — Financial and Security Policy Engine.
Strictly separates:
1. AI payment assessment (advisory only)
2. Deterministic business-rule validation
3. Human authorization
4. Actual PayPal transaction
5. Transaction confirmation
6. Persistent audit record

Guarantees:
- Never releases or reports a payment as successful when an exception occurs.
- Never uses mock transaction IDs in production paths.
- The AI must never independently authorize financial transfers.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import List, Optional, Tuple

from backend.schemas.approvals import (
    FinancialRiskFlag,
    PaymentProposalModel,
    PolicyEvaluationResult,
)


PLATFORM_FEE_RATE = 0.15  # 15% platform fee consistent with lib/paypal/orders.ts
DEFAULT_TRUST_THRESHOLD = 75


def calculate_fee_breakdown(gross_amount_cents: int) -> Tuple[int, int, int]:
    """
    Deterministically computes (gross_cents, platform_fee_cents, net_cents).
    Matches Next.js calculatePlatformFee in lib/paypal/orders.ts.
    """
    if gross_amount_cents <= 0:
        raise ValueError("gross_amount_cents must be strictly positive")
    fee_cents = int(round(gross_amount_cents * PLATFORM_FEE_RATE))
    net_cents = gross_amount_cents - fee_cents
    return gross_amount_cents, fee_cents, net_cents


def evaluate_payment_policy(
    *,
    gross_amount_cents: int,
    project_total_budget_cents: int,
    project_already_paid_cents: int,
    trust_score: int,
    required_threshold: int = DEFAULT_TRUST_THRESHOLD,
    all_objective_criteria_passed: bool = True,
    head_sha_verified: bool = True,
    recipient_email: str = "",
    existing_risk_flags: Optional[List[FinancialRiskFlag]] = None,
) -> Tuple[PolicyEvaluationResult, List[FinancialRiskFlag]]:
    """
    Stage 2: Deterministic Business-Rule Validation.
    Evaluates payment eligibility purely using deterministic rules.
    """
    flags: List[FinancialRiskFlag] = list(existing_risk_flags or [])
    reasons: List[str] = []

    # 1. Trust score threshold check
    if trust_score < required_threshold:
        flags.append(
            FinancialRiskFlag(
                code="TRUST_SCORE_BELOW_THRESHOLD",
                severity="high",
                description=f"Deliverable trust score ({trust_score}) is below required threshold ({required_threshold}).",
                blocking=True,
            )
        )
        reasons.append(f"Trust score {trust_score} < {required_threshold} minimum threshold.")
    else:
        reasons.append(f"Trust score {trust_score} meets >= {required_threshold} threshold.")

    # 2. Objective acceptance criteria check
    if not all_objective_criteria_passed:
        flags.append(
            FinancialRiskFlag(
                code="INCOMPLETE_ACCEPTANCE_CRITERIA",
                severity="high",
                description="One or more objective deliverable acceptance criteria have not passed.",
                blocking=True,
            )
        )
        reasons.append("Objective acceptance criteria check failed.")
    else:
        reasons.append("All objective acceptance criteria passed.")

    # 3. Git commit SHA verification check
    if not head_sha_verified:
        flags.append(
            FinancialRiskFlag(
                code="UNVERIFIED_COMMIT_SHA",
                severity="critical",
                description="Deliverable commit SHA could not be deterministically verified against the repository.",
                blocking=True,
            )
        )
        reasons.append("Commit SHA verification failed.")

    # 4. Budget ceiling check
    remaining_budget_cents = max(0, project_total_budget_cents - project_already_paid_cents)
    budget_within_bounds = True
    if project_total_budget_cents > 0 and gross_amount_cents > remaining_budget_cents:
        budget_within_bounds = False
        flags.append(
            FinancialRiskFlag(
                code="BUDGET_CEILING_EXCEEDED",
                severity="critical",
                description=(
                    f"Proposed payout ({gross_amount_cents} cents) exceeds remaining project budget "
                    f"({remaining_budget_cents} cents)."
                ),
                blocking=True,
            )
        )
        reasons.append("Proposed payout exceeds remaining project budget.")
    else:
        reasons.append("Proposed payout is within project budget bounds.")

    # 5. Recipient email check
    if not recipient_email or "@" not in recipient_email:
        flags.append(
            FinancialRiskFlag(
                code="INVALID_RECIPIENT_EMAIL",
                severity="critical",
                description="Recipient PayPal email is missing or invalid.",
                blocking=True,
            )
        )
        reasons.append("Recipient PayPal email is invalid.")

    # 6. High-value transaction review flag (non-blocking warning, still requires human auth)
    if gross_amount_cents >= 1000000:  # >= $10,000.00
        flags.append(
            FinancialRiskFlag(
                code="HIGH_VALUE_MILESTONE",
                severity="medium",
                description="Milestone payout is >= $10,000.00 USD; dual executive sign-off recommended.",
                blocking=False,
            )
        )

    no_blocking_flags = not any(f.blocking for f in flags)
    passed = (
        trust_score >= required_threshold
        and all_objective_criteria_passed
        and head_sha_verified
        and budget_within_bounds
        and no_blocking_flags
    )

    policy_result = PolicyEvaluationResult(
        passed=passed,
        trust_score=trust_score,
        required_threshold=required_threshold,
        all_objective_criteria_passed=all_objective_criteria_passed,
        head_sha_verified=head_sha_verified,
        budget_within_bounds=budget_within_bounds,
        no_blocking_risk_flags=no_blocking_flags,
        reasons=reasons,
    )
    return policy_result, flags


def build_payment_proposal(
    *,
    project_id: str,
    milestone_id: str,
    milestone_title: str,
    recipient_email: str,
    gross_amount_cents: int,
    currency: str,
    ai_eligibility_assessment: str,
    policy_evaluation: PolicyEvaluationResult,
    risk_flags: List[FinancialRiskFlag],
    execution_id: Optional[str] = None,
    consultant_id: Optional[str] = None,
) -> PaymentProposalModel:
    """
    Constructs a strict PaymentProposalModel in status 'pending_human_approval'.
    Requires explicit human authorization before any PayPal API call can be made.
    """
    gross, fee, net = calculate_fee_breakdown(gross_amount_cents)
    recommended_action = (
        "request_human_approval"
        if policy_evaluation.passed
        else ("hold_for_remediation" if policy_evaluation.trust_score >= 40 else "reject")
    )
    return PaymentProposalModel(
        proposal_id=f"pprop-{uuid.uuid4().hex[:12]}",
        execution_id=execution_id,
        project_id=project_id,
        milestone_id=milestone_id,
        milestone_title=milestone_title,
        recipient_email=recipient_email,
        consultant_id=consultant_id,
        gross_amount_cents=gross,
        platform_fee_cents=fee,
        net_amount_cents=net,
        currency=currency.upper(),
        ai_eligibility_assessment=ai_eligibility_assessment,
        ai_recommended_action=recommended_action,
        risk_flags=risk_flags,
        policy_evaluation=policy_evaluation,
        status="pending_human_approval",
        requires_human_authorization=True,
        created_at=datetime.utcnow().isoformat(),
    )
