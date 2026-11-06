"""
AG Grid Server-Side Data Shaping, Filtering, Sorting, and Summary Aggregation Helpers.
Supports ConsultAI's 7 operational grids:
Consultants, Projects, Tasks, Companies, Contracts, Payments, Agent Executions.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def apply_grid_query(
    rows: List[Dict[str, Any]],
    *,
    search: Optional[str] = None,
    status_filter: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: str = "desc",
    limit: int = 250,
    offset: int = 0,
) -> Dict[str, Any]:
    """
    Applies deterministic filtering, sorting, and pagination to operational grid rows
    and calculates aggregate summary metrics.
    """
    filtered = list(rows)

    if status_filter and status_filter.lower() != "all":
        target_status = status_filter.strip().lower()
        filtered = [
            r for r in filtered if str(r.get("status") or "").strip().lower() == target_status
        ]

    if search and search.strip():
        q = search.strip().lower()
        filtered = [
            r
            for r in filtered
            if any(q in str(val).lower() for val in r.values() if val is not None)
        ]

    if sort_by:
        reverse = sort_dir.lower() != "asc"
        filtered.sort(
            key=lambda item: (item.get(sort_by) is None, str(item.get(sort_by) or "")),
            reverse=reverse,
        )

    total_count = len(filtered)
    sliced = filtered[offset : offset + limit]

    return {
        "rows": sliced,
        "totalCount": total_count,
        "limit": limit,
        "offset": offset,
    }
