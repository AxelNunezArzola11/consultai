"""
Neon PostgreSQL Async Database Tooling.
Uses existing Neon database and Drizzle schema tables as the single source of truth.
Also ensures new operational tables (agent_executions, scheduling_proposals, candidate_vetting)
exist when connected.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional
import asyncpg

logger = logging.getLogger("consultai.tools.database")

_pool: Optional[asyncpg.Pool] = None


def get_database_dsn() -> Optional[str]:
    """Resolves the PostgreSQL connection string from NEON_DATABASE_URL or DATABASE_URL."""
    for env_key in ("NEON_DATABASE_URL", "DATABASE_URL"):
        val = os.getenv(env_key, "").strip()
        if val and (val.startswith("postgres://") or val.startswith("postgresql://")):
            return val
    return None


async def init_db_pool() -> Optional[asyncpg.Pool]:
    """Initializes the global asyncpg connection pool and ensures operational tables exist."""
    global _pool
    if _pool is not None:
        return _pool

    dsn = get_database_dsn()
    if not dsn:
        logger.warning(
            "Neither NEON_DATABASE_URL nor DATABASE_URL is configured with a valid postgres DSN. "
            "Database persistence will use explicit fallback mode until configured."
        )
        return None

    try:
        _pool = await asyncpg.create_pool(
            dsn=dsn,
            min_size=1,
            max_size=10,
            command_timeout=15.0,
        )
        async with _pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS candidate_vetting (
                    id SERIAL PRIMARY KEY,
                    github_username TEXT NOT NULL,
                    role_target TEXT NOT NULL,
                    trust_score INTEGER NOT NULL,
                    can_do JSONB NOT NULL DEFAULT '[]'::jsonb,
                    cannot_do JSONB NOT NULL DEFAULT '[]'::jsonb,
                    summary TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS agent_executions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    user_request TEXT NOT NULL,
                    intent TEXT NOT NULL,
                    supervisor_decision JSONB NOT NULL DEFAULT '{}'::jsonb,
                    delegated_agents JSONB NOT NULL DEFAULT '[]'::jsonb,
                    handoffs JSONB NOT NULL DEFAULT '[]'::jsonb,
                    status TEXT NOT NULL DEFAULT 'running',
                    approval_status TEXT NOT NULL DEFAULT 'not_required',
                    structured_outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
                    tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
                    errors JSONB NOT NULL DEFAULT '[]'::jsonb,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    prompt_tokens INTEGER NOT NULL DEFAULT 0,
                    completion_tokens INTEGER NOT NULL DEFAULT 0,
                    total_tokens INTEGER NOT NULL DEFAULT 0,
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    final_result TEXT NOT NULL DEFAULT '',
                    requested_by TEXT NOT NULL DEFAULT 'company-operator',
                    decided_by TEXT,
                    decided_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS scheduling_proposals (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    execution_id TEXT,
                    proposed_by_agent TEXT NOT NULL DEFAULT 'reschedule_agent',
                    overall_risk TEXT NOT NULL DEFAULT 'medium',
                    total_delay_days INTEGER NOT NULL DEFAULT 0,
                    rationale TEXT NOT NULL DEFAULT '',
                    adjustments JSONB NOT NULL DEFAULT '[]'::jsonb,
                    conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
                    status TEXT NOT NULL DEFAULT 'pending_approval',
                    decided_by TEXT,
                    decided_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                """
            )
        logger.info("Connected to Neon PostgreSQL pool and verified schema tables.")
        return _pool
    except Exception as exc:
        logger.error("Failed to initialize Neon PostgreSQL pool: %s", exc)
        _pool = None
        return None


async def close_db_pool() -> None:
    """Gracefully closes the asyncpg connection pool."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        logger.info("Closed Neon PostgreSQL connection pool.")


def get_pool() -> Optional[asyncpg.Pool]:
    return _pool


async def fetch_project_context(project_id: Optional[str]) -> Dict[str, Any]:
    """
    Loads real project, milestones, and candidates from the shared Neon PostgreSQL tables
    (projects, milestones, candidates) created by Drizzle ORM.
    """
    pool = await init_db_pool()
    if pool is None:
        return {"db_connected": False, "project": None, "milestones": [], "candidates": []}

    # Real Drizzle columns (lib/db/schema.ts):
    #   projects:   id, company_id, title, raw_brief, ..., status, created_at
    #                (no brief/budget_cents columns — budget lives on milestones.budget_usd)
    #   milestones: id, project_id, title, description, budget_usd, status, start_date,
    #                due_date, depends_on_id, version, created_at, ...
    #   candidates: id, project_id, name, email, github_handle, trust_score, rank, status, ...
    # Aliases preserve the keys existing workflow/agent consumers read.
    try:
        async with pool.acquire() as conn:
            project_cols = """
                SELECT p.id, p.company_id, p.title, p.raw_brief AS brief, p.status, p.created_at,
                       (COALESCE((SELECT SUM(m.budget_usd) FROM milestones m WHERE m.project_id = p.id), 0) * 100)::bigint AS budget_cents
                FROM projects p
            """
            if project_id:
                project_row = await conn.fetchrow(
                    project_cols + " WHERE p.id = $1",
                    project_id,
                )
            else:
                project_row = await conn.fetchrow(
                    project_cols + " ORDER BY p.created_at DESC LIMIT 1"
                )

            if not project_row:
                return {"db_connected": True, "project": None, "milestones": [], "candidates": []}

            resolved_pid = project_row["id"]
            milestone_rows = await conn.fetch(
                """
                SELECT id, project_id, title, description, (budget_usd * 100)::bigint AS amount_cents,
                       status, start_date, due_date, depends_on_id AS depends_on, version, created_at
                FROM milestones
                WHERE project_id = $1
                ORDER BY due_date ASC NULLS LAST, created_at ASC
                """,
                resolved_pid,
            )
            candidate_rows = await conn.fetch(
                """
                SELECT id, project_id, name, email, github_handle, rank,
                       trust_score AS confidence_score, status, created_at
                FROM candidates
                WHERE project_id = $1
                ORDER BY rank ASC NULLS LAST, trust_score DESC NULLS LAST
                """,
                resolved_pid,
            )

            return {
                "db_connected": True,
                "project": dict(project_row),
                "milestones": [dict(r) for r in milestone_rows],
                "candidates": [dict(r) for r in candidate_rows],
            }
    except Exception as exc:
        logger.warning("Error fetching project context from DB: %s", exc)
        return {"db_connected": False, "project": None, "milestones": [], "candidates": [], "error": str(exc)}


async def save_candidate_vetting(
    *,
    github_username: str,
    role_target: str,
    trust_score: int,
    can_do: List[str],
    cannot_do: List[str],
    summary: str,
) -> Optional[int]:
    """Persists a candidate vetting record to Neon PostgreSQL."""
    pool = await init_db_pool()
    if pool is None:
        return None
    async with pool.acquire() as conn:
        row_id = await conn.fetchval(
            """
            INSERT INTO candidate_vetting (
                github_username, role_target, trust_score, can_do, cannot_do, summary
            )
            VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
            RETURNING id
            """,
            github_username,
            role_target,
            trust_score,
            json.dumps(can_do),
            json.dumps(cannot_do),
            summary,
        )
        return int(row_id) if row_id is not None else None
