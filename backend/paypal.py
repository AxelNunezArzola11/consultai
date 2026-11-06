"""
Backward-compatible `backend.paypal` module delegating to `backend.tools.paypal`.
Enforces Section 5 Financial & Security rules:
- Never hardcodes live PayPal URL when in sandbox.
- Never fabricates mock batch IDs.
"""
from decimal import Decimal
from typing import Any, Dict

from backend.tools.paypal import (
    PayPalAPIError,
    PayPalConfigError,
    create_verified_payout,
    get_paypal_access_token,
    get_paypal_base_url,
)

__all__ = [
    "PayPalAPIError",
    "PayPalConfigError",
    "get_paypal_access_token",
    "get_paypal_base_url",
    "create_payout",
]


async def create_payout(
    recipient_email: str,
    amount: float | int | str | Decimal,
    currency: str = "USD",
    milestone_id: str = "milestone-default",
    note: str = "ConsultAI automated milestone payout",
    approval_id: str = "",
    authorized_by: str = "",
) -> Dict[str, Any]:
    """
    Executes a verified PayPal payout. Requires human authorization (`approval_id` and `authorized_by`).
    """
    return await create_verified_payout(
        recipient_email=recipient_email,
        amount_dollars=amount,
        currency=currency,
        milestone_id=milestone_id,
        approval_id=approval_id,
        authorized_by=authorized_by,
        note=note,
    )
