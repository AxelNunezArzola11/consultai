"""
Append-Only Persistent Audit Log Service.
Writes operational, financial, and security events to the shared Neon PostgreSQL `audit_log` table.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from backend.tools.database import init_db_pool

logger = logging.getLogger("consultai.services.audit")

_memory_audit_fallback: List[Dict[str, Any]] = []


async def write_audit_record(
    *,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str,
    payload: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Appends an immutable audit entry to the `audit_log` table in Neon PostgreSQL.
    Never throws on DB unavailability during non-financial reads, but records in memory fallback if DB is offline.
    """
    safe_payload = payload or {}
    entry = {
        "actor": actor,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "payload_json": safe_payload,
        "created_at": datetime.utcnow().isoformat(),
    }
    _memory_audit_fallback.insert(0, entry)
    del _memory_audit_fallback[200:]

    # Real audit_log columns (lib/db/schema.ts + 0000 migration):
    #   id bigserial PK (DB-assigned), entity_type, entity_id, event, actor, payload jsonb, created_at.
    # The `action` argument maps to the `event` column.
    pool = await init_db_pool()
    if pool is not None:
        try:
            async with pool.acquire() as conn:
                row_id = await conn.fetchval(
                    """
                    INSERT INTO audit_log (entity_type, entity_id, event, actor, payload)
                    VALUES ($1, $2, $3, $4, $5::jsonb)
                    RETURNING id
                    """,
                    entity_type,
                    entity_id,
                    action,
                    actor,
                    json.dumps(safe_payload),
                )
                entry["id"] = row_id
                return str(row_id)
        except Exception as exc:
            logger.warning("Failed to persist audit record to Neon DB: %s", exc)

    record_id = f"aud-{uuid.uuid4().hex[:14]}"
    entry["id"] = record_id
    return record_id


async def list_recent_audit_logs(limit: int = 50) -> List[Dict[str, Any]]:
    """Fetches recent audit log records from Neon PostgreSQL."""
    pool = await init_db_pool()
    if pool is None:
        return _memory_audit_fallback[:limit]

    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, actor, event AS action, entity_type, entity_id, payload AS payload_json, created_at
                FROM audit_log
                ORDER BY created_at DESC
                LIMIT $1
                """,
                limit,
            )
            results: List[Dict[str, Any]] = []
            for r in rows:
                d = dict(r)
                if isinstance(d.get("created_at"), datetime):
                    d["created_at"] = d["created_at"].isoformat()
                if isinstance(d.get("payload_json"), str):
                    try:
                        d["payload_json"] = json.loads(d["payload_json"])
                    except Exception:
                        pass
                results.append(d)
            return results
    except Exception as exc:
        logger.warning("Failed to query audit_log from DB: %s", exc)
        return _memory_audit_fallback[:limit]
