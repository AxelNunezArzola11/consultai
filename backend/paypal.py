"""
PayPal Payouts API helper.
"""
from __future__ import annotations

import base64
import os
import uuid
from typing import Any

import httpx


PAYPAL_BASE_URL = "https://api-m.paypal.com"  # production; swap to sandbox for testing


async def _get_access_token() -> str:
    client_id = os.environ["PAYPAL_CLIENT_ID"]
    client_secret = os.environ["PAYPAL_CLIENT_SECRET"]
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{PAYPAL_BASE_URL}/v1/oauth2/token",
            headers={
                "Authorization": f"Basic {credentials}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials"},
            timeout=15.0,
        )
        response.raise_for_status()
        return response.json()["access_token"]


async def release_milestone_payout(
    recipient_email: str,
    amount_usd: float,
    milestone_id: str,
    note: str = "Milestone payout from ConsultAI",
) -> dict[str, Any]:
    """
    Trigger a PayPal Payout for a single recipient.
    Returns the PayPal API response dict on success.
    Raises httpx.HTTPStatusError on failure.
    """
    token = await _get_access_token()
    sender_batch_id = f"consultai-milestone-{milestone_id}-{uuid.uuid4().hex[:8]}"

    payload = {
        "sender_batch_header": {
            "sender_batch_id": sender_batch_id,
            "email_subject": "ConsultAI Milestone Payout",
            "email_message": note,
        },
        "items": [
            {
                "recipient_type": "EMAIL",
                "amount": {
                    "value": f"{amount_usd:.2f}",
                    "currency": "USD",
                },
                "receiver": recipient_email,
                "note": note,
                "sender_item_id": milestone_id,
            }
        ],
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{PAYPAL_BASE_URL}/v1/payments/payouts",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=20.0,
        )
        response.raise_for_status()
        return response.json()
