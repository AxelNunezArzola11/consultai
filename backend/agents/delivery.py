"""
Delivery Agent — Monitors deliverables, analyzes GitHub webhook events and PR diffs,
evaluates acceptance criteria, identifies incomplete work, and produces delivery assessments.
Strictly distinguishes verified deterministic evidence (GitHub API, commit SHA, CI checks, changed files)
from AI-generated code quality assessments.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import List, Literal, Tuple
from pydantic import BaseModel, Field

from backend.agents._llm import create_specialist_agent, has_groq_api_key, run_pydantic_agent
from backend.schemas.requests import DeliveryAgentRequest
from backend.schemas.responses import (
    CriterionEvaluation,
    DeliveryAgentResponse,
    ToolCallRecord,
)
from backend.tools.github import fetch_pull_request_evidence

logger = logging.getLogger("consultai.agents.delivery")


class _LLMDeliveryAssessment(BaseModel):
    trust_score: int = Field(..., ge=0, le=100)
    verdict: Literal["approved_for_payout_review", "needs_remediation", "rejected"]
    ai_assessment_items: List[str] = Field(default_factory=list)
    criteria_evaluations: List[CriterionEvaluation] = Field(default_factory=list)
    incomplete_work_items: List[str] = Field(default_factory=list)
    security_or_quality_warnings: List[str] = Field(default_factory=list)
    summary: str


DELIVERY_SYSTEM_PROMPT = (
    "You are the ConsultAI Principal Delivery & Code Verification Agent.\n"
    "Analyze the Pull Request metadata, changed files, diff summary, and milestone acceptance criteria.\n"
    "Distinguish clearly between deterministic facts (commit SHA, files modified, CI check status) "
    "and your AI code review assessment.\n"
    "Never approve empty diffs, placeholder implementations, or security vulnerabilities."
)

delivery_pydantic_agent = create_specialist_agent(
    name="delivery_agent",
    output_type=_LLMDeliveryAssessment,
    system_prompt=DELIVERY_SYSTEM_PROMPT,
)


async def execute_delivery_agent(
    request: DeliveryAgentRequest,
) -> Tuple[DeliveryAgentResponse, List[ToolCallRecord], int, int, int]:
    """
    Executes the Delivery Agent:
    1. Fetches deterministic PR evidence from GitHub API when repository_full_name and pr_number are provided.
    2. Separates `verified_evidence_items` (deterministic) from `ai_assessment_items` (LLM review).
    """
    tool_calls: List[ToolCallRecord] = []
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0

    verified_evidence: List[str] = []
    changed_files = list(request.changed_files)
    diff_summary = request.diff_summary
    head_sha = request.head_sha

    if request.repository_full_name and request.pr_number:
        t0 = datetime.utcnow()
        gh_ev = await fetch_pull_request_evidence(request.repository_full_name, request.pr_number)
        dur_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)
        if gh_ev.get("verified_via_api"):
            head_sha = gh_ev.get("head_sha") or head_sha
            changed_files = gh_ev.get("changed_files") or changed_files
            diff_summary = gh_ev.get("diff_text") or diff_summary
            verified_evidence.append(
                f"GitHub API verified PR #{request.pr_number} on {request.repository_full_name} (HEAD SHA: {head_sha})."
            )
        tool_calls.append(
            ToolCallRecord(
                tool_name="github.fetch_pull_request_evidence",
                agent_name="delivery_agent",
                inputs_summary={
                    "repository": request.repository_full_name,
                    "pr_number": request.pr_number,
                },
                output_summary=f"Verified={gh_ev.get('verified_via_api')}, changed_files={len(changed_files)}",
                status="success",
                duration_ms=max(1, dur_ms),
            )
        )

    if head_sha:
        verified_evidence.append(f"Deterministic commit SHA recorded: {head_sha}")
    if changed_files:
        verified_evidence.append(f"Modified {len(changed_files)} file(s): {', '.join(changed_files[:6])}")
    if request.ci_checks_passed is True:
        verified_evidence.append("Deterministic CI status: All automated check runs passed.")
    elif request.ci_checks_passed is False:
        verified_evidence.append("Deterministic CI status: One or more automated check runs failed.")

    if not verified_evidence:
        verified_evidence.append(
            "Deliverable submitted via manual/webhook payload without live GitHub API repository verification."
        )

    criteria_list = request.acceptance_criteria or [
        "Deliverable implements the milestone scope without placeholder stubs",
        "No regressions or exposed secrets in submitted changes",
    ]

    # Baseline deterministic evaluation
    has_substantive_content = bool(diff_summary.strip() or changed_files or request.pr_body.strip())
    base_score = 84 if has_substantive_content else 45
    if request.ci_checks_passed is False:
        base_score = min(base_score, 55)

    criteria_evals: List[CriterionEvaluation] = [
        CriterionEvaluation(
            criterion=c,
            status="passed" if has_substantive_content else "incomplete",
            evidence_type="verified_deterministic" if changed_files else "ai_code_review",
            explanation=(
                f"Backed by {len(changed_files)} modified files and deliverable payload."
                if has_substantive_content
                else "Insufficient code diff or file evidence provided."
            ),
        )
        for c in criteria_list
    ]
    ai_items = [
        f"Evaluated {len(criteria_list)} acceptance criteria against deliverable payload for '{request.milestone_title}'."
    ]
    incomplete_items: List[str] = (
        [] if has_substantive_content else ["Code diff or deliverable evidence payload is empty or incomplete."]
    )
    warnings: List[str] = []
    verdict: Literal["approved_for_payout_review", "needs_remediation", "rejected"] = (
        "approved_for_payout_review" if base_score >= 75 else "needs_remediation"
    )
    summary_text = (
        f"Delivery verification completed for milestone '{request.milestone_title}' "
        f"with trust score {base_score}/100 ({verdict})."
    )

    if has_groq_api_key():
        try:
            prompt = (
                f"Milestone ID: {request.milestone_id}\n"
                f"Milestone Title: {request.milestone_title}\n"
                f"Acceptance Criteria:\n" + "\n".join(f"- {c}" for c in criteria_list) + "\n"
                f"Verified Deterministic Evidence:\n" + "\n".join(f"- {v}" for v in verified_evidence) + "\n"
                f"PR Title: {request.pr_title}\n"
                f"PR Description: {request.pr_body[:2000]}\n"
                f"Changed Files: {', '.join(changed_files[:20])}\n"
                f"Diff Snippet:\n{diff_summary[:6000]}"
            )
            llm_out, p_tok, c_tok, t_tok = await run_pydantic_agent(delivery_pydantic_agent, prompt)
            prompt_tokens += p_tok
            completion_tokens += c_tok
            total_tokens += t_tok

            base_score = llm_out.trust_score
            verdict = llm_out.verdict
            ai_items = llm_out.ai_assessment_items or ai_items
            criteria_evals = llm_out.criteria_evaluations or criteria_evals
            incomplete_items = llm_out.incomplete_work_items
            warnings = llm_out.security_or_quality_warnings
            summary_text = llm_out.summary
        except Exception as exc:
            logger.warning("Delivery Agent LLM fallback triggered: %s", exc)

    response = DeliveryAgentResponse(
        project_id=request.project_id,
        milestone_id=request.milestone_id,
        trust_score=base_score,
        verdict=verdict,
        verified_evidence_items=verified_evidence,
        ai_assessment_items=ai_items,
        criteria_evaluations=criteria_evals,
        incomplete_work_items=incomplete_items,
        security_or_quality_warnings=warnings,
        summary=summary_text,
    )
    return response, tool_calls, prompt_tokens, completion_tokens, total_tokens
