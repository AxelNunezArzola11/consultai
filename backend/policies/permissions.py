"""
Role-Based Access Control (RBAC) and API-Level Authorization Policies.
Protects administrative operations, financial authorizations, and schedule mutations.
"""
from __future__ import annotations

import hmac
import hashlib
import os
from typing import Literal, Optional, Set
from fastapi import Header, HTTPException, Request, status

RoleType = Literal["company", "freelancer", "admin"]

ROLE_PERMISSIONS: dict[RoleType, Set[str]] = {
    "company": {
        "orchestrator:execute",
        "orchestrator:read",
        "planning:propose",
        "planning:approve",
        "talent:evaluate",
        "delivery:verify",
        "finance:propose",
        "finance:approve_payout",
        "operations:read",
        "operations:write",
    },
    "freelancer": {
        "orchestrator:read",
        "delivery:submit",
        "delivery:verify",
        "operations:read_own",
    },
    "admin": {
        "orchestrator:execute",
        "orchestrator:read",
        "planning:propose",
        "planning:approve",
        "talent:evaluate",
        "delivery:submit",
        "delivery:verify",
        "finance:propose",
        "finance:approve_payout",
        "operations:read",
        "operations:write",
        "admin:audit",
        "admin:disputes",
        "admin:system",
    },
}


class AuthenticatedActor:
    """Represents the verified actor invoking a backend endpoint."""

    def __init__(self, actor_id: str, role: RoleType, verified: bool = True):
        self.actor_id = actor_id
        self.role: RoleType = role
        self.verified = verified

    def has_permission(self, permission: str) -> bool:
        return permission in ROLE_PERMISSIONS.get(self.role, set())


def resolve_actor_from_request(
    request: Request,
    x_consultai_role: Optional[str] = Header(default=None),
    x_consultai_actor: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> AuthenticatedActor:
    """
    Extracts and validates the caller's role and identity from headers or internal API secret.
    Defaults to 'company' operator for backward-compatible internal dashboard requests unless restricted.
    """
    internal_secret = os.getenv("INTERNAL_API_SECRET", "").strip()
    if internal_secret and authorization == f"Bearer {internal_secret}":
        role_val: RoleType = "admin" if x_consultai_role == "admin" else "company"
        return AuthenticatedActor(
            actor_id=x_consultai_actor or "internal-service",
            role=role_val,
            verified=True,
        )

    raw_role = (x_consultai_role or "company").strip().lower()
    if raw_role not in ("company", "freelancer", "admin"):
        raw_role = "company"

    actor_id = (x_consultai_actor or f"{raw_role}-operator").strip()
    return AuthenticatedActor(actor_id=actor_id, role=raw_role, verified=True)  # type: ignore[arg-type]


def require_internal_service_secret(authorization: Optional[str]) -> None:
    """
    Money-movement gate: requires `Authorization: Bearer <INTERNAL_API_SECRET>`.
    Fails closed — if the secret is not configured, or the bearer does not match,
    the payout endpoint refuses. No anonymous caller may reach PayPal execution.
    """
    internal_secret = os.getenv("INTERNAL_API_SECRET", "").strip()
    if not internal_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Payout service is not configured (INTERNAL_API_SECRET missing).",
        )
    if not authorization or not hmac.compare_digest(
        authorization.strip(), f"Bearer {internal_secret}"
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Valid internal service credentials are required for payout operations.",
        )


def require_permission(actor: AuthenticatedActor, permission: str) -> None:
    """Raises HTTP 403 if the authenticated actor lacks the required permission."""
    if not actor.has_permission(permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Role '{actor.role}' is not authorized for permission '{permission}'.",
        )


def require_human_authorization_actor(actor_id: Optional[str], actor_role: Optional[str]) -> None:
    """
    Enforces Section 5 rule:
    The AI must NEVER independently authorize financial transfers or schedule mutations.
    Only a human operator with role 'company' or 'admin' can authorize.
    """
    if not actor_id or not actor_id.strip():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Explicit human actor_id is required to authorize this operation.",
        )

    normalized_actor = actor_id.strip().lower()
    forbidden_ai_prefixes = ("ai", "agent", "supervisor", "finance_agent", "planning_agent", "system_auto", "bot")
    if normalized_actor in forbidden_ai_prefixes or normalized_actor.startswith("ai-") or normalized_actor.startswith("agent-"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Security Policy Violation: AI agents cannot independently authorize financial transfers or schedule mutations.",
        )

    if actor_role not in ("company", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Role '{actor_role}' cannot authorize financial or schedule proposals. Must be 'company' or 'admin'.",
        )


def verify_github_webhook_signature(raw_body: bytes, signature_header: Optional[str]) -> bool:
    """
    Validates GitHub HMAC-SHA256 webhook signature (X-Hub-Signature-256).
    If GITHUB_WEBHOOK_SECRET is configured, enforces strict constant-time comparison.
    """
    secret = os.getenv("GITHUB_WEBHOOK_SECRET", "").strip()
    if not secret:
        # When secret is not set in local dev, allow only if explicitly not in strict prod mode
        if os.getenv("RENDER") or os.getenv("VERCEL_ENV") == "production":
            return False
        return True

    if not signature_header or not signature_header.startswith("sha256="):
        return False

    expected = "sha256=" + hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.strip())
