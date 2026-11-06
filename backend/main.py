"""
ConsultAI Backend Application Entrypoint (`backend.main`).
Exposes:
- Multi-Agent Orchestrator & Specialist Agent endpoints (`backend.orchestrator.router`)
- GitHub Webhook Verification (`POST /api/webhooks/github`) with HMAC signature validation
- Financial Threshold & Payout Verification (`POST /api/payouts/check-threshold`) with strict 6-stage separation
- Health & Readiness Probes (`GET /health`, `GET /ready`)
"""
from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import os
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware

from backend.agents.delivery import execute_delivery_agent
from backend.agents.finance import execute_finance_agent
from backend.db import close_db, get_pool, init_db
from backend.models import (
    GitHubWebhookPayload,
    PRVerificationResult,
    ThresholdCheckRequest,
    ThresholdCheckResponse,
)
from backend.orchestrator.router import router as orchestrator_router
from backend.orchestrator.state import telemetry_registry
from backend.paypal import PayPalAPIError, PayPalConfigError
from backend.policies.permissions import (
    require_human_authorization_actor,
    require_internal_service_secret,
    verify_github_webhook_signature,
)
from backend.schemas.requests import DeliveryAgentRequest, FinanceAgentRequest
from backend.services.audit import write_audit_record
from backend.tools.paypal import create_verified_payout

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("consultai.backend")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting ConsultAI Multi-Agent Backend Service...")
    await init_db()
    yield
    logger.info("Shutting down ConsultAI Multi-Agent Backend Service...")
    await close_db()


app = FastAPI(
    title="ConsultAI Multi-Agent Orchestration & Autonomous Operations API",
    version="2.0.0",
    description=(
        "Production-grade PydanticAI Multi-Agent Consulting & Project Management Backend "
        "with Supervisor Orchestration, Bryntum Gantt, AG Grid Operations, and 6-Stage Financial Security."
    ),
    lifespan=lifespan,
)

raw_origins = os.getenv("CORS_ALLOW_ORIGINS", "*")
allow_origins = [o.strip() for o in raw_origins.split(",") if o.strip()] or ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=False if "*" in allow_origins else True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount the Multi-Agent Orchestrator & AI Operations Center router
app.include_router(orchestrator_router)


@app.get("/health", tags=["System"])
async def health_check() -> Dict[str, Any]:
    """Liveness probe for Render & uptime monitors."""
    return {
        "status": "ok",
        "service": "consultai-multi-agent-backend",
        "version": "2.0.0",
        "agents_registered": len(telemetry_registry.list_status()),
    }


@app.get("/ready", tags=["System"])
async def readiness_check() -> Dict[str, Any]:
    """Readiness probe verifying database pool and LLM configuration state."""
    pool = get_pool()
    db_ready = pool is not None
    groq_configured = bool(os.getenv("GROQ_API_KEY", "").strip())
    paypal_configured = bool(
        os.getenv("PAYPAL_CLIENT_ID", "").strip() and os.getenv("PAYPAL_CLIENT_SECRET", "").strip()
    )
    return {
        "status": "ready",
        "database_connected": db_ready,
        "groq_llm_configured": groq_configured,
        "paypal_configured": paypal_configured,
    }


@app.post(
    "/api/webhooks/github",
    response_model=PRVerificationResult,
    status_code=status.HTTP_200_OK,
    tags=["Webhooks"],
)
async def github_webhook_handler(
    request: Request,
    x_github_event: Optional[str] = Header(default=None),
    x_hub_signature_256: Optional[str] = Header(default=None),
) -> PRVerificationResult:
    """
    Receives GitHub pull_request webhooks, validates HMAC-SHA256 signature,
    and delegates verification to the Delivery Agent.
    """
    raw_body = await request.body()
    if not verify_github_webhook_signature(raw_body, x_hub_signature_256):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing GitHub webhook HMAC-SHA256 signature.",
        )

    try:
        payload = GitHubWebhookPayload.model_validate_json(raw_body)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid GitHub webhook payload: {exc}",
        ) from exc

    if x_github_event and x_github_event != "pull_request":
        return PRVerificationResult(
            trust_score=0,
            verdict="needs_work",
            summary=f"Ignored non-PR GitHub event: {x_github_event}",
            strengths=[],
            blocking_issues=["Event is not a pull_request"],
            recommended_payout_percentage=0,
        )

    if payload.pull_request is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing pull_request object in webhook payload.",
        )

    pr = payload.pull_request
    logger.info(
        "Verifying PR #%s (%s) on %s via Delivery Agent",
        pr.number,
        payload.action,
        payload.repository.full_name,
    )

    d_req = DeliveryAgentRequest(
        project_id="proj-webhook",
        milestone_id=f"pr-{pr.number}",
        milestone_title=pr.title,
        pr_url=pr.html_url,
        repository_full_name=payload.repository.full_name,
        pr_number=pr.number,
        pr_title=pr.title,
        pr_body=pr.body or "",
    )
    d_resp, _, _, _, _ = await execute_delivery_agent(d_req)

    verdict_map: Dict[str, Any] = {
        "approved_for_payout_review": "approved",
        "needs_remediation": "needs_work",
        "rejected": "rejected",
    }
    mapped_verdict = verdict_map.get(d_resp.verdict, "needs_work")
    rec_pct = 100 if d_resp.trust_score >= 80 else (50 if d_resp.trust_score >= 60 else 0)

    await write_audit_record(
        actor="github_webhook",
        action="delivery.webhook_verified",
        entity_type="milestone",
        entity_id=f"pr-{pr.number}",
        payload={
            "repository": payload.repository.full_name,
            "pr_number": pr.number,
            "trust_score": d_resp.trust_score,
            "verdict": mapped_verdict,
        },
    )

    return PRVerificationResult(
        trust_score=d_resp.trust_score,
        verdict=mapped_verdict,
        summary=d_resp.summary,
        strengths=d_resp.verified_evidence_items + d_resp.ai_assessment_items,
        blocking_issues=d_resp.incomplete_work_items + d_resp.security_or_quality_warnings,
        recommended_payout_percentage=rec_pct,
    )


@app.post(
    "/api/payouts/check-threshold",
    response_model=ThresholdCheckResponse,
    status_code=status.HTTP_200_OK,
    tags=["Financial Operations"],
)
async def check_threshold_and_payout(
    req: ThresholdCheckRequest,
    authorization: Optional[str] = Header(default=None),
) -> ThresholdCheckResponse:
    """
    Section 5 — 6-Stage Separated Financial Endpoint:
    0. Internal service authentication (`INTERNAL_API_SECRET` bearer — rejects anonymous callers)
    1. AI Payment Assessment (Finance Agent)
    2. Deterministic Business-Rule Validation (`evaluate_payment_policy`)
    3. Human Authorization Check (`approval_id` + `authorized_by`)
    4. Actual PayPal Transaction (`create_verified_payout`)
    5. Transaction Confirmation (`payout_batch_id`)
    6. Persistent Audit Record (`write_audit_record`)

    CRITICAL GUARANTEE:
    - Never releases a payment without human authorization.
    - Never returns `payout_released=True` or a mock transaction ID when an exception occurs.
    """
    require_internal_service_secret(authorization)
    if req.trust_score < req.threshold:
        await write_audit_record(
            actor=req.authorized_by or "policy_engine",
            action="payment.threshold_rejected",
            entity_type="milestone",
            entity_id=req.milestone_id,
            payload={"trust_score": req.trust_score, "threshold": req.threshold},
        )
        return ThresholdCheckResponse(
            milestone_id=req.milestone_id,
            trust_score=req.trust_score,
            threshold_met=False,
            payout_released=False,
            payout_batch_id=None,
            requires_human_authorization=True,
            status="below_threshold",
            message=(
                f"Trust score {req.trust_score} is below required threshold {req.threshold}. "
                "Payout withheld by deterministic policy."
            ),
        )

    gross_cents = int(round(req.amount * 100))

    # Stages 1 & 2: Run Finance Agent + Deterministic Policy Validation
    f_req = FinanceAgentRequest(
        project_id="proj-payout-check",
        milestone_id=req.milestone_id,
        milestone_title=f"Milestone {req.milestone_id}",
        recipient_email=req.recipient_email,
        gross_amount_cents=gross_cents,
        currency=req.currency,
        trust_score=req.trust_score,
        all_criteria_passed=True,
        head_sha_verified=True,
    )
    f_resp, _, _, _, _ = await execute_finance_agent(f_req)
    proposal = f_resp.payment_proposal

    if not proposal.policy_evaluation.passed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "Deterministic payment policy validation failed.",
                "reasons": proposal.policy_evaluation.reasons,
            },
        )

    # Stage 3: Human Authorization Gate
    # If the request does not include an explicit human approval_id + authorized_by,
    # return the PaymentProposal awaiting human authorization (NEVER transfer money autonomously).
    if not req.approval_id or not req.authorized_by:
        await write_audit_record(
            actor="finance_agent",
            action="payment.proposal_created",
            entity_type="payment",
            entity_id=proposal.proposal_id,
            payload={
                "milestone_id": req.milestone_id,
                "gross_amount_cents": proposal.gross_amount_cents,
                "net_amount_cents": proposal.net_amount_cents,
                "status": "awaiting_human_authorization",
            },
        )
        return ThresholdCheckResponse(
            milestone_id=req.milestone_id,
            trust_score=req.trust_score,
            threshold_met=True,
            payout_released=False,
            payout_batch_id=None,
            proposal_id=proposal.proposal_id,
            requires_human_authorization=True,
            status="awaiting_human_authorization",
            message=(
                f"Stage 1 & 2 passed. Payment proposal '{proposal.proposal_id}' created for "
                f"${proposal.net_amount_cents / 100:.2f} {req.currency} net. "
                "Awaiting Stage 3 explicit human authorization (approval_id & authorized_by) before PayPal execution."
            ),
        )

    # Verify the authorizing actor is a human with role company/admin (never an AI agent)
    require_human_authorization_actor(req.authorized_by, req.actor_role)

    # Stage 4 & 5: Execute Real PayPal Payout & Confirm Batch ID
    # Never catch and return fake success on failure!
    try:
        net_dollars = proposal.net_amount_cents / 100.0
        payout_data = await create_verified_payout(
            recipient_email=req.recipient_email,
            amount_dollars=net_dollars,
            currency=req.currency,
            milestone_id=req.milestone_id,
            approval_id=req.approval_id,
            authorized_by=req.authorized_by,
        )
        batch_id = payout_data.get("batch_header", {}).get("payout_batch_id")
        if not batch_id:
            raise PayPalAPIError("PayPal response did not include a confirmed payout_batch_id.")
    except (PayPalConfigError, PayPalAPIError) as exc:
        await write_audit_record(
            actor=req.authorized_by,
            action="payment.paypal_failed",
            entity_type="milestone",
            entity_id=req.milestone_id,
            payload={"approval_id": req.approval_id, "error": str(exc)},
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PayPal transaction failed: {exc}. Payment was NOT released.",
        ) from exc
    except Exception as exc:
        await write_audit_record(
            actor=req.authorized_by,
            action="payment.unexpected_error",
            entity_type="milestone",
            entity_id=req.milestone_id,
            payload={"approval_id": req.approval_id, "error": str(exc)},
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected error during payout execution: {exc}. Payment was NOT released.",
        ) from exc

    # Stage 6: Persistent Audit Record
    await write_audit_record(
        actor=req.authorized_by,
        action="payment.payout_confirmed",
        entity_type="payment",
        entity_id=batch_id,
        payload={
            "milestone_id": req.milestone_id,
            "approval_id": req.approval_id,
            "proposal_id": proposal.proposal_id,
            "gross_amount_cents": proposal.gross_amount_cents,
            "platform_fee_cents": proposal.platform_fee_cents,
            "net_amount_cents": proposal.net_amount_cents,
            "paypal_batch_id": batch_id,
        },
    )

    return ThresholdCheckResponse(
        milestone_id=req.milestone_id,
        trust_score=req.trust_score,
        threshold_met=True,
        payout_released=True,
        payout_batch_id=batch_id,
        proposal_id=proposal.proposal_id,
        requires_human_authorization=True,
        status="payout_released",
        message=f"Human-authorized PayPal payout confirmed (Batch ID: {batch_id}).",
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "10000"))
    uvicorn.run("backend.main:app", host="0.0.0.0", port=port, reload=False)
