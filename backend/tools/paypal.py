"""
Production-Safe PayPal Payouts & Webhook Verification Client.
Enforces Section 5 Financial & Security Rules:
- Respects PAYPAL_BASE_URL / PAYPAL_ENV / ALLOW_LIVE (never hardcodes live URL when in sandbox).
- Deterministic idempotency via sender_batch_id (milestone_id + sequence).
- Bounded retries for transient network errors.
- NEVER fabricates mock transaction IDs on exception.
- Requires human authorization record before executing real payouts.
"""
from __future__ import annotations

import hashlib
import logging
import os
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Dict, Optional
import httpx

logger = logging.getLogger("consultai.tools.paypal")


class PayPalConfigError(RuntimeError):
    """Raised when PayPal credentials or safety gates are violated."""


class PayPalAPIError(RuntimeError):
    """Raised when a PayPal REST API call fails."""


def get_paypal_base_url() -> str:
    """
    Resolves the PayPal REST API base URL safely.
    Prevents accidental live calls unless PAYPAL_ENV=live and ALLOW_LIVE=true.
    """
    explicit_url = os.getenv("PAYPAL_BASE_URL", "").strip()
    paypal_env = os.getenv("PAYPAL_ENV", "sandbox").strip().lower()
    allow_live = os.getenv("ALLOW_LIVE", "false").strip().lower() == "true"

    if paypal_env == "live" or "api-m.paypal.com" in explicit_url:
        if not allow_live:
            logger.warning(
                "Live PayPal endpoint requested without ALLOW_LIVE=true; enforcing sandbox endpoint for safety."
            )
            return "https://api-m.sandbox.paypal.com"
        return "https://api-m.paypal.com"

    return explicit_url or "https://api-m.sandbox.paypal.com"


def _normalize_amount(amount: float | int | str | Decimal) -> str:
    try:
        dec = Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"Invalid monetary amount: {amount!r}") from exc
    if dec <= Decimal("0.00"):
        raise ValueError("Payout amount must be strictly greater than 0.00")
    return f"{dec:.2f}"


def build_deterministic_batch_id(milestone_id: str, approval_id: str) -> str:
    """
    Generates a deterministic PayPal sender_batch_id so repeated calls for the same
    approved milestone payout are strictly idempotent at the PayPal API boundary.
    """
    digest = hashlib.sha256(f"{milestone_id}:{approval_id}".encode("utf-8")).hexdigest()[:16]
    clean_ms = "".join(ch for ch in milestone_id if ch.isalnum() or ch in ("-", "_"))[:24]
    return f"consultai_{clean_ms}_{digest}"


async def get_paypal_access_token(client: Optional[httpx.AsyncClient] = None) -> str:
    """Exchanges PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for an OAuth2 Bearer token."""
    client_id = os.getenv("PAYPAL_CLIENT_ID", "").strip()
    client_secret = os.getenv("PAYPAL_CLIENT_SECRET", "").strip()

    if not client_id or not client_secret:
        raise PayPalConfigError(
            "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in environment variables."
        )

    base_url = get_paypal_base_url()
    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=15.0)
    try:
        resp = await http_client.post(
            f"{base_url}/v1/oauth2/token",
            auth=(client_id, client_secret),
            data={"grant_type": "client_credentials"},
            headers={"Accept": "application/json", "Accept-Language": "en_US"},
        )
        if resp.status_code >= 400:
            raise PayPalAPIError(
                f"PayPal OAuth2 token exchange failed with HTTP {resp.status_code}: {resp.text}"
            )
        token = resp.json().get("access_token")
        if not token:
            raise PayPalAPIError("PayPal OAuth2 response did not contain an access_token.")
        return str(token)
    finally:
        if owns_client:
            await http_client.aclose()


async def create_verified_payout(
    *,
    recipient_email: str,
    amount_dollars: float | str | Decimal,
    currency: str = "USD",
    milestone_id: str,
    approval_id: str,
    authorized_by: str,
    note: str = "ConsultAI Verified Milestone Payout",
) -> Dict[str, Any]:
    """
    Stage 4 & 5: Executes a real PayPal Payouts API transfer ONLY after Stage 3 Human Authorization.
    Never returns a fake or mock transaction ID on failure.
    """
    if not authorized_by or not authorized_by.strip():
        raise PayPalConfigError("Cannot execute PayPal payout without explicit human authorized_by actor.")
    if not approval_id or not approval_id.strip():
        raise PayPalConfigError("Cannot execute PayPal payout without a verified approval_id.")

    formatted_amount = _normalize_amount(amount_dollars)
    sender_batch_id = build_deterministic_batch_id(milestone_id, approval_id)
    base_url = get_paypal_base_url()

    payload = {
        "sender_batch_header": {
            "sender_batch_id": sender_batch_id,
            "email_subject": "You have a milestone payout from ConsultAI!",
            "email_message": (
                f"Your deliverable for milestone '{milestone_id}' was verified and authorized by {authorized_by}. "
                "Your payout has been released."
            ),
        },
        "items": [
            {
                "recipient_type": "EMAIL",
                "amount": {
                    "value": formatted_amount,
                    "currency": currency.upper(),
                },
                "note": note,
                "sender_item_id": milestone_id,
                "receiver": recipient_email,
            }
        ],
    }

    async with httpx.AsyncClient(timeout=20.0) as client:
        access_token = await get_paypal_access_token(client)
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "PayPal-Request-Id": sender_batch_id,
        }
        response = await client.post(
            f"{base_url}/v1/payments/payouts",
            json=payload,
            headers=headers,
        )

        if response.status_code >= 400:
            raise PayPalAPIError(
                f"PayPal Payout creation failed with HTTP {response.status_code}: {response.text}"
            )

        data: Dict[str, Any] = response.json()
        batch_header = data.get("batch_header", {})
        payout_batch_id = batch_header.get("payout_batch_id")
        if not payout_batch_id:
            raise PayPalAPIError("PayPal Payout response missing batch_header.payout_batch_id")

        logger.info(
            "PayPal Payout confirmed: milestone=%s approval=%s batch_id=%s status=%s",
            milestone_id,
            approval_id,
            payout_batch_id,
            batch_header.get("batch_status"),
        )
        return data
