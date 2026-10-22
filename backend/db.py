"""
Database helpers — thin asyncpg wrapper for Neon Postgres.
"""
from __future__ import annotations

import os
from typing import Any

import asyncpg


_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        dsn = os.environ["NEON_DATABASE_URL"]
        _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)
    return _pool


async def fetch_one(query: str, *args: Any) -> asyncpg.Record | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def execute(query: str, *args: Any) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(query, *args)


# ---------------------------------------------------------------------------
# Domain helpers
# ---------------------------------------------------------------------------

async def upsert_vetting_result(result: dict[str, Any]) -> None:
    """Insert or update a candidate vetting result row."""
    await execute(
        """
        INSERT INTO candidate_vetting
            (candidate_id, pr_number, trust_score, status,
             code_quality_summary, test_coverage_estimate, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (candidate_id, pr_number) DO UPDATE
            SET trust_score            = EXCLUDED.trust_score,
                status                 = EXCLUDED.status,
                code_quality_summary   = EXCLUDED.code_quality_summary,
                test_coverage_estimate = EXCLUDED.test_coverage_estimate,
                updated_at             = NOW()
        """,
        result["candidate_id"],
        result["pr_number"],
        result["trust_score"],
        result["status"],
        result["code_quality_summary"],
        result.get("test_coverage_estimate"),
    )


async def get_milestone(milestone_id: str) -> asyncpg.Record | None:
    return await fetch_one(
        "SELECT * FROM milestones WHERE id = $1", milestone_id
    )


async def update_milestone_status(milestone_id: str, status: str, payout_batch_id: str | None = None) -> None:
    await execute(
        """
        UPDATE milestones
        SET status = $2, paypal_payout_batch_id = $3, updated_at = NOW()
        WHERE id = $1
        """,
        milestone_id,
        status,
        payout_batch_id,
    )
