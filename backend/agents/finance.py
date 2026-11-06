"""
Finance Agent — Calculates proposed milestone payments, evaluates payment eligibility,
identifies financial risks, and prepares structured PaymentProposalModels.
Strictly enforces Section 5:
- Separates AI payment assessment from deterministic business-rule validation.
- NEVER executes a PayPal transfer directly.
- ALWAYS sets requires_human_authorization=True.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import List, Optional, Tuple
from pydantic import BaseModel, Field

from backend.agents._llm import create_specialist_agent, has_groq_api_key, run_pydantic_agent
from backend.policies.payments import (
    build_payment_proposal,
    calculate_fee_breakdown,
    evaluate_payment_policy,
)
from backend.schemas.approvals import FinancialRiskFlag
from backend.schemas.requests import FinanceAgentRequest
from backend.schemas.responses import FinanceAgentResponse, ToolCallRecord

logger = logging.getLogger("consultai.agents.finance")


class _LLMFinanceAssessment(BaseModel):
    ai_eligibility_assessment: str
    additional_risk_flags: List[FinancialRiskFlag] = Field(default_factory=list)
    summary: str


FINANCE_SYSTEM_PROMPT = (
    "You are the ConsultAI Principal Financial Risk & Escrow Assessment Agent.\n"
    "Review the milestone payout parameters, delivery trust score, and project budget.\n"
    "Provide a clear, audit-ready eligibility assessment and identify any financial or compliance risks.\n"
    "CRITICAL SECURITY POLICY: You can only prepare a PaymentProposal requiring explicit human authorization. "
    "You must NEVER claim a payout has been executed or authorized by AI."
)

finance_pydantic_agent = create_specialist_agent(
    name="finance_agent",
    output_type=_LLMFinanceAssessment,
    system_prompt=FINANCE_SYSTEM_PROMPT,
)


async def execute_finance_agent(
    request: FinanceAgentRequest,
    execution_id: Optional[str] = None,
) -> Tuple[FinanceAgentResponse, List[ToolCallRecord], int, int, int]:
    """
    Executes Stage 1 (AI Financial Assessment) + Stage 2 (Deterministic Policy Evaluation)
    to produce a PaymentProposalModel awaiting Stage 3 (Human Authorization).
    """
    tool_calls: List[ToolCallRecord] = []
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0

    t0 = datetime.utcnow()
    gross, fee, net = calculate_fee_breakdown(request.gross_amount_cents)
    policy_eval, det_flags = evaluate_payment_policy(
        gross_amount_cents=request.gross_amount_cents,
        project_total_budget_cents=request.project_total_budget_cents,
        project_already_paid_cents=request.project_already_paid_cents,
        trust_score=request.trust_score,
        all_objective_criteria_passed=request.all_criteria_passed,
        head_sha_verified=request.head_sha_verified,
        recipient_email=request.recipient_email,
    )
    dur_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)

    tool_calls.append(
        ToolCallRecord(
            tool_name="policies.evaluate_payment_policy",
            agent_name="finance_agent",
            inputs_summary={
                "milestone_id": request.milestone_id,
                "gross_amount_cents": gross,
                "trust_score": request.trust_score,
            },
            output_summary=(
                f"Policy passed={policy_eval.passed}, gross=${gross/100:.2f}, "
                f"fee=${fee/100:.2f}, net=${net/100:.2f}, flags={len(det_flags)}"
            ),
            status="success",
            duration_ms=max(1, dur_ms),
        )
    )

    ai_assessment = (
        f"Milestone '{request.milestone_title}' ({request.milestone_id}) evaluated for gross payout of "
        f"${gross / 100:,.2f} {request.currency} (15% platform fee: ${fee / 100:,.2f}, net consultant transfer: "
        f"${net / 100:,.2f}). Deterministic policy check {'PASSED' if policy_eval.passed else 'BLOCKED'}: "
        + " ".join(policy_eval.reasons)
    )
    summary_text = (
        f"Prepared payment proposal for '${net / 100:,.2f}' net to {request.recipient_email}. "
        f"Status: Pending explicit human authorization."
    )

    if has_groq_api_key():
        try:
            prompt = (
                f"Project ID: {request.project_id}\n"
                f"Milestone: {request.milestone_title} ({request.milestone_id})\n"
                f"Recipient Email: {request.recipient_email}\n"
                f"Gross Amount: ${gross / 100:,.2f} {request.currency}\n"
                f"Platform Fee (15%): ${fee / 100:,.2f} {request.currency}\n"
                f"Net Payout: ${net / 100:,.2f} {request.currency}\n"
                f"Deliverable Trust Score: {request.trust_score}/100\n"
                f"Deterministic Policy Passed: {policy_eval.passed}\n"
                f"Policy Reasons: {'; '.join(policy_eval.reasons)}\n"
                f"Delivery Summary: {request.delivery_summary}"
            )
            llm_out, p_tok, c_tok, t_tok = await run_pydantic_agent(finance_pydantic_agent, prompt)
            prompt_tokens += p_tok
            completion_tokens += c_tok
            total_tokens += t_tok
            ai_assessment = llm_out.ai_eligibility_assessment
            summary_text = llm_out.summary
            for extra_flag in llm_out.additional_risk_flags:
                if not any(f.code == extra_flag.code for f in det_flags):
                    det_flags.append(extra_flag)
        except Exception as exc:
            logger.warning("Finance Agent LLM fallback triggered: %s", exc)

    proposal = build_payment_proposal(
        project_id=request.project_id,
        milestone_id=request.milestone_id,
        milestone_title=request.milestone_title,
        recipient_email=request.recipient_email,
        gross_amount_cents=request.gross_amount_cents,
        currency=request.currency,
        ai_eligibility_assessment=ai_assessment,
        policy_evaluation=policy_eval,
        risk_flags=det_flags,
        execution_id=execution_id,
        consultant_id=request.consultant_id,
    )

    response = FinanceAgentResponse(
        project_id=request.project_id,
        milestone_id=request.milestone_id,
        eligible_for_proposal=policy_eval.passed,
        payment_proposal=proposal,
        summary=summary_text,
    )
    return response, tool_calls, prompt_tokens, completion_tokens, total_tokens
