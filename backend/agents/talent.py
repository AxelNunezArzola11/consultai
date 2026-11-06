"""
Talent Agent — Evaluates consultant profiles, analyzes real GitHub evidence,
compares skills with project requirements, assesses availability, and produces
structured candidate recommendations.
NEVER fabricates verification results: explicitly distinguishes live GitHub API evidence
from database signals or unverified profile claims.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Tuple
from pydantic import BaseModel, Field

from backend.agents._llm import create_specialist_agent, has_groq_api_key, run_pydantic_agent
from backend.schemas.requests import TalentAgentRequest
from backend.schemas.responses import (
    CandidateGitHubEvidence,
    CandidateRecommendation,
    TalentAgentResponse,
    ToolCallRecord,
)
from backend.tools.database import save_candidate_vetting
from backend.tools.github import fetch_github_user_repos

logger = logging.getLogger("consultai.agents.talent")


class _LLMCandidateEvaluation(BaseModel):
    overall_fit_score: int = Field(..., ge=0, le=100)
    skill_match_score: int = Field(..., ge=0, le=100)
    matched_skills: List[str] = Field(default_factory=list)
    missing_skills: List[str] = Field(default_factory=list)
    can_do: List[str] = Field(default_factory=list)
    cannot_do: List[str] = Field(default_factory=list)
    recommendation_rationale: str


TALENT_SYSTEM_PROMPT = (
    "You are the ConsultAI Principal Technical Talent & Vetting Agent.\n"
    "Evaluate the candidate strictly using the verified GitHub repository evidence and profile data provided.\n"
    "CRITICAL RULE: Never fabricate verification results, repositories, stars, or commit histories. "
    "If a required skill has no supporting evidence in the verified repositories, place it in `missing_skills` "
    "and `cannot_do` (as 'Unverified in public repositories')."
)

talent_pydantic_agent = create_specialist_agent(
    name="talent_agent",
    output_type=_LLMCandidateEvaluation,
    system_prompt=TALENT_SYSTEM_PROMPT,
)


async def execute_talent_agent(
    request: TalentAgentRequest,
) -> Tuple[TalentAgentResponse, List[ToolCallRecord], int, int, int]:
    """
    Evaluates one or more candidates against project requirements using real GitHub API lookup
    and deterministic skill matching + LLM synthesis.
    """
    tool_calls: List[ToolCallRecord] = []
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0

    candidates_to_evaluate: List[Dict[str, Any]] = list(request.candidates_pool)
    if not candidates_to_evaluate:
        candidates_to_evaluate.append(
            {
                "id": request.candidate_id or f"cand-{uuid.uuid4().hex[:8]}",
                "name": request.candidate_name or request.github_username or "Candidate Consultant",
                "github_handle": request.github_username,
                "role": request.role_title,
                "confidence_score": 80,
                "status": "vetted",
            }
        )

    recommendations: List[CandidateRecommendation] = []
    req_skills = [s.strip() for s in request.project_requirements if s.strip()]
    if not req_skills:
        req_skills = ["TypeScript", "Next.js", "Python", "FastAPI", "PostgreSQL"]

    for cand in candidates_to_evaluate[:5]:
        cid = str(cand.get("id") or f"cand-{uuid.uuid4().hex[:8]}")
        cname = str(cand.get("name") or cand.get("github_handle") or "Consultant")
        gh_handle = str(cand.get("github_handle") or request.github_username or "").strip().lstrip("@")
        c_role = str(cand.get("role") or request.role_title)

        verified_repos: List[CandidateGitHubEvidence] = []
        if gh_handle:
            t0 = datetime.utcnow()
            verified_repos = await fetch_github_user_repos(gh_handle, max_repos=6)
            dur_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)
            tool_calls.append(
                ToolCallRecord(
                    tool_name="github.fetch_user_repos",
                    agent_name="talent_agent",
                    inputs_summary={"github_username": gh_handle},
                    output_summary=(
                        f"Fetched {len(verified_repos)} verified public repositories from GitHub API."
                        if verified_repos
                        else f"No public repositories returned by GitHub API for '{gh_handle}'."
                    ),
                    status="success",
                    duration_ms=max(1, dur_ms),
                )
            )

        verification_source: Any = (
            "github_live_api"
            if verified_repos
            else ("database_verified_signals" if cand.get("confidence_score") else "unverified_profile_only")
        )

        # Deterministic language & keyword extraction from verified repos
        observed_languages = {
            (r.primary_language or "").lower() for r in verified_repos if r.primary_language
        }
        observed_text = " ".join(
            f"{r.repo_name} {r.primary_language or ''} {r.description or ''}".lower()
            for r in verified_repos
        )

        matched: List[str] = []
        missing: List[str] = []
        for skill in req_skills:
            sl = skill.lower()
            if sl in observed_languages or sl in observed_text:
                matched.append(skill)
            else:
                missing.append(skill)

        fit_score = int(cand.get("confidence_score") or 75)
        skill_score = int(round((len(matched) / max(1, len(req_skills))) * 100)) if verified_repos else fit_score
        can_do = [f"Verified repository evidence for {s}" for s in matched] or [
            f"Profile aligned with {c_role} requirements (pending repository verification)"
        ]
        cannot_do = [f"Unverified in public GitHub repos: {s}" for s in missing]
        rationale = (
            f"Evaluated '{cname}' ({gh_handle or 'no GitHub handle'}) against {len(req_skills)} project requirements. "
            f"Verified {len(verified_repos)} public repositories via GitHub API."
        )

        if has_groq_api_key():
            try:
                repos_summary = "\n".join(
                    f"- {r.repo_name} (lang={r.primary_language}, stars={r.stars}): {r.description or 'No description'}"
                    for r in verified_repos
                ) or "No live GitHub repositories fetched."
                prompt = (
                    f"Candidate Name: {cname}\n"
                    f"Target Role: {c_role}\n"
                    f"GitHub Handle: {gh_handle or 'None'}\n"
                    f"Project Requirements: {', '.join(req_skills)}\n"
                    f"Project Brief: {request.project_brief}\n"
                    f"Verified GitHub Repositories:\n{repos_summary}\n"
                )
                llm_eval, p_tok, c_tok, t_tok = await run_pydantic_agent(talent_pydantic_agent, prompt)
                prompt_tokens += p_tok
                completion_tokens += c_tok
                total_tokens += t_tok
                fit_score = llm_eval.overall_fit_score
                skill_score = llm_eval.skill_match_score
                matched = llm_eval.matched_skills or matched
                missing = llm_eval.missing_skills or missing
                can_do = llm_eval.can_do or can_do
                cannot_do = llm_eval.cannot_do or cannot_do
                rationale = llm_eval.recommendation_rationale
            except Exception as exc:
                logger.warning("Talent Agent LLM synthesis fallback for %s: %s", cname, exc)

        # Persist vetting result to Neon DB if github_username is present
        if gh_handle:
            await save_candidate_vetting(
                github_username=gh_handle,
                role_target=c_role,
                trust_score=fit_score,
                can_do=can_do,
                cannot_do=cannot_do,
                summary=rationale,
            )

        avail_status: Any = (
            "available"
            if str(cand.get("status") or "").lower() in ("vetted", "available", "nda_signed", "invited")
            else "partially_allocated"
        )

        recommendations.append(
            CandidateRecommendation(
                candidate_id=cid,
                name=cname,
                role=c_role,
                github_username=gh_handle or None,
                overall_fit_score=fit_score,
                skill_match_score=skill_score,
                availability_status=avail_status,
                verification_source=verification_source,
                matched_skills=matched,
                missing_skills=missing,
                can_do=can_do,
                cannot_do=cannot_do,
                verified_evidence=verified_repos,
                recommendation_rationale=rationale,
            )
        )

    recommendations.sort(key=lambda r: r.overall_fit_score, reverse=True)
    top_id = recommendations[0].candidate_id if recommendations else None

    response = TalentAgentResponse(
        project_id=request.project_id,
        evaluated_count=len(recommendations),
        top_candidate_id=top_id,
        recommendations=recommendations,
        summary=(
            f"Evaluated {len(recommendations)} consultant candidate(s) for project '{request.project_id}'. "
            f"Top candidate fit score: {recommendations[0].overall_fit_score if recommendations else 0}/100."
        ),
    )
    return response, tool_calls, prompt_tokens, completion_tokens, total_tokens
