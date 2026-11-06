"""
Backward-compatible `backend.db` wrapper delegating to `backend.tools.database`.
"""
from typing import List, Optional
import asyncpg

from backend.models import CandidateVettingResult
from backend.tools.database import (
    close_db_pool as close_db,
    get_pool,
    init_db_pool as init_db,
    save_candidate_vetting,
)

__all__ = ["init_db", "close_db", "get_pool", "save_vetting_result", "get_vetting_results"]


async def save_vetting_result(result: CandidateVettingResult) -> Optional[int]:
    return await save_candidate_vetting(
        github_username=result.github_username,
        role_target=result.role_target,
        trust_score=result.trust_score,
        can_do=result.can_do,
        cannot_do=result.cannot_do,
        summary=result.summary,
    )


async def get_vetting_results(github_username: str) -> List[dict]:
    pool: Optional[asyncpg.Pool] = await init_db()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, github_username, role_target, trust_score, can_do, cannot_do, summary, created_at
            FROM candidate_vetting
            WHERE github_username = $1
            ORDER BY created_at DESC
            """,
            github_username,
        )
        return [dict(r) for r in rows]
