"""
ConsultAI FastAPI backend — main application entry point.

Endpoints:
  POST /api/webhooks/github          — GitHub webhook listener (PR merged / push)
  POST /api/payouts/check-threshold  — Milestone payout threshold check & release
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from .agents import run_vetting, run_payout_check
from .db import upsert_vetting_result, get_milestone, update_milestone_status
from .paypal import release_milestone_payout


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm-up: nothing expensive needed at start; pool is lazy.
    yield


app = FastAPI(
    title="ConsultAI Backend",
    description="FastAPI + PydanticAI backend for ConsultAI powered by Groq",
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _verify_github_signature(payload: bytes, signature_header: str | None) -> None:
    """Validate GitHub HMAC-SHA256 webhook signature."""
    secret = os.environ.get("GITHUB_WEBHOOK_SECRET", "")
    if not secret:
        return  # Skip verification if secret not configured (dev mode)

    if not signature_header or not signature_header.startswith("sha256="):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed X-Hub-Signature-256 header",
        )

    expected = "sha256=" + hmac.new(
        secret.encode(), payload, digestmod=hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, signature_header):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook signature",
        )


# ---------------------------------------------------------------------------
# Background task — runs PydanticAI vetting after webhook delivery
# ---------------------------------------------------------------------------

async def _vet_and_persist(
    candidate_id: str,
    pr_number: int,
    diff_url: str,
) -> None:
    """Fetch the diff, run AI vetting, and persist the result to Neon."""
    import httpx  # local import to keep startup fast

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            diff_response = await client.get(
                diff_url,
                headers={"Accept": "application/vnd.github.v3.diff"},
            )
            diff_text = diff_response.text if diff_response.status_code == 200 else ""
    except Exception:
        diff_text = ""

    result = await run_vetting(candidate_id, pr_number, diff_text)
    await upsert_vetting_result(result.model_dump())


# ---------------------------------------------------------------------------
# Route 1 — GitHub Webhook
# ---------------------------------------------------------------------------

class WebhookResponse(BaseModel):
    received: bool
    event: str
    action: str | None = None
    detail: str = ""


@app.post(
    "/api/webhooks/github",
    response_model=WebhookResponse,
    summary="GitHub Webhook Listener",
    tags=["webhooks"],
)
async def github_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_hub_signature_256: str | None = Header(None),
    x_github_event: str | None = Header(None),
) -> WebhookResponse:
    """
    Receives `pull_request` (closed/merged) and `push` events from GitHub.
    For merged PRs, triggers a background PydanticAI vetting task that
    analyses the diff and updates candidate/milestone progress in Neon Postgres.
    """
    raw_body = await request.body()
    _verify_github_signature(raw_body, x_hub_signature_256)

    try:
        payload: dict[str, Any] = json.loads(raw_body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON payload")

    event = x_github_event or "unknown"
    action = payload.get("action")

    # Handle pull_request.closed (merged)
    if event == "pull_request" and action == "closed":
        pr = payload.get("pull_request", {})
        merged = pr.get("merged", False)

        if merged:
            pr_number = pr.get("number", 0)
            # Use the sender login as a proxy for candidate_id
            candidate_id = pr.get("user", {}).get("login", "unknown")
            diff_url = pr.get("url", "")

            background_tasks.add_task(
                _vet_and_persist,
                candidate_id,
                pr_number,
                diff_url,
            )
            return WebhookResponse(
                received=True,
                event=event,
                action=action,
                detail=f"Vetting task queued for PR #{pr_number} by {candidate_id}",
            )

    # Handle push events — log receipt, no vetting needed
    if event == "push":
        ref = payload.get("ref", "")
        commits = len(payload.get("commits", []))
        return WebhookResponse(
            received=True,
            event=event,
            action=None,
            detail=f"Push to {ref} with {commits} commit(s) acknowledged",
        )

    # All other events acknowledged but not processed
    return WebhookResponse(
        received=True,
        event=event,
        action=action,
        detail="Event acknowledged but not processed",
    )


# ---------------------------------------------------------------------------
# Route 2 — Threshold Payment Engine
# ---------------------------------------------------------------------------

class ThresholdCheckRequest(BaseModel):
    milestone_id: str = Field(..., description="Milestone to evaluate")
    candidate_id: str = Field(..., description="Candidate associated with the milestone")
    recipient_email: str = Field(..., description="PayPal recipient email for payout")
    budget_usd: float = Field(..., gt=0.0, description="Milestone budget in USD")
    trust_score: float = Field(..., ge=0.0, le=100.0, description="Current candidate trust score")
    tests_passing: bool = Field(..., description="Whether all unit tests are passing")


class ThresholdCheckResponse(BaseModel):
    milestone_id: str
    threshold_met: bool
    payout_released: bool
    payout_batch_id: str | None = None
    reason: str


@app.post(
    "/api/payouts/check-threshold",
    response_model=ThresholdCheckResponse,
    summary="Check Milestone Payout Threshold",
    tags=["payouts"],
)
async def check_payout_threshold(body: ThresholdCheckRequest) -> ThresholdCheckResponse:
    """
    Evaluates whether a milestone's payout threshold has been met.
    Threshold: Trust Score >= 75 AND all unit tests passing.
    When met, triggers a PayPal Payout API release for the milestone budget.
    """
    # Run AI payout check
    check = await run_payout_check(
        milestone_id=body.milestone_id,
        candidate_id=body.candidate_id,
        budget_usd=body.budget_usd,
        trust_score=body.trust_score,
        tests_passing=body.tests_passing,
    )

    if not check.threshold_met:
        # Update DB status to pending/failed
        await update_milestone_status(body.milestone_id, "pending")
        return ThresholdCheckResponse(
            milestone_id=body.milestone_id,
            threshold_met=False,
            payout_released=False,
            reason=check.reason,
        )

    # Threshold met — trigger PayPal payout
    try:
        paypal_response = await release_milestone_payout(
            recipient_email=body.recipient_email,
            amount_usd=body.budget_usd,
            milestone_id=body.milestone_id,
        )
        batch_id = (
            paypal_response
            .get("batch_header", {})
            .get("payout_batch_id")
        )
        await update_milestone_status(body.milestone_id, "payout_released", batch_id)
        return ThresholdCheckResponse(
            milestone_id=body.milestone_id,
            threshold_met=True,
            payout_released=True,
            payout_batch_id=batch_id,
            reason=f"Payout of ${body.budget_usd:.2f} USD released. Batch ID: {batch_id}",
        )
    except Exception as exc:
        await update_milestone_status(body.milestone_id, "failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PayPal payout failed: {exc}",
        )


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "consultai-backend"}
