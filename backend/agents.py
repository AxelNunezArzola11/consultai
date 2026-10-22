"""
PydanticAI agents powered by Groq (model configured via GROQ_MODEL env var).
"""
from __future__ import annotations
import os
from pydantic_ai import Agent
from pydantic_ai.models.groq import GroqModel

from .models import CandidateVettingResult, MilestonePayoutCheck, TimelineReschedulePlan


def _groq_model() -> GroqModel:
    model_id = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
    return GroqModel(model_id)


# ---------------------------------------------------------------------------
# Agent 1 — Candidate vetting
# ---------------------------------------------------------------------------

vetting_agent: Agent[None, CandidateVettingResult] = Agent(
    model=_groq_model(),
    output_type=CandidateVettingResult,
    system_prompt=(
        "You are an expert code reviewer evaluating freelance candidates for a consulting platform. "
        "Analyse the provided GitHub pull request diff and return a structured vetting result. "
        "Be objective, concise, and security-conscious. "
        "Assign a trust_score from 0-100 based on code quality, test coverage, security, and best practices."
    ),
)


async def run_vetting(candidate_id: str, pr_number: int, diff: str) -> CandidateVettingResult:
    prompt = (
        f"Candidate ID: {candidate_id}\n"
        f"Pull Request: #{pr_number}\n\n"
        f"Diff:\n```\n{diff}\n```\n\n"
        "Please vet this submission and return the structured result."
    )
    result = await vetting_agent.run(prompt)
    output = result.data
    # Ensure the IDs match the request
    output.candidate_id = candidate_id
    output.pr_number = pr_number
    return output


# ---------------------------------------------------------------------------
# Agent 2 — Milestone payout check
# ---------------------------------------------------------------------------

payout_agent: Agent[None, MilestonePayoutCheck] = Agent(
    model=_groq_model(),
    output_type=MilestonePayoutCheck,
    system_prompt=(
        "You are a milestone payout evaluator for a consulting platform. "
        "Given a milestone's details, candidate trust score, and test status, "
        "determine whether the payout threshold has been met. "
        "threshold_met is True only when trust_score >= 75 AND tests_passing is True."
    ),
)


async def run_payout_check(
    milestone_id: str,
    candidate_id: str,
    budget_usd: float,
    trust_score: float,
    tests_passing: bool,
) -> MilestonePayoutCheck:
    prompt = (
        f"Milestone ID: {milestone_id}\n"
        f"Candidate ID: {candidate_id}\n"
        f"Budget: ${budget_usd:.2f} USD\n"
        f"Trust Score: {trust_score:.1f}/100\n"
        f"All unit tests passing: {tests_passing}\n\n"
        "Evaluate whether the payout threshold has been met and return the structured result."
    )
    result = await payout_agent.run(prompt)
    output = result.data
    output.milestone_id = milestone_id
    output.candidate_id = candidate_id
    output.budget_usd = budget_usd
    output.trust_score = trust_score
    output.tests_passing = tests_passing
    output.threshold_met = trust_score >= 75.0 and tests_passing
    return output


# ---------------------------------------------------------------------------
# Agent 3 — Timeline reschedule
# ---------------------------------------------------------------------------

reschedule_agent: Agent[None, TimelineReschedulePlan] = Agent(
    model=_groq_model(),
    output_type=TimelineReschedulePlan,
    system_prompt=(
        "You are a project timeline analyst for a consulting platform. "
        "Given a project's current milestone statuses and blockers, "
        "produce a realistic reschedule plan with per-milestone adjustments."
    ),
)
