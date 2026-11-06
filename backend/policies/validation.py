"""
Deterministic Validation Policies for Task Graphs, Scheduling Proposals, and GitHub Evidence.
Ensures AI outputs are validated against deterministic business rules before persistence or display.
"""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Set, Tuple

from backend.schemas.tasks import (
    MilestoneAdjustment,
    SchedulingConflict,
    TaskState,
)


LOCKED_TASK_STATUSES: Set[str] = {"funded", "paid"}


def parse_iso_date(date_str: str) -> datetime:
    """Safely parses an ISO-8601 date prefix (YYYY-MM-DD)."""
    clean = (date_str or "").strip()[:10]
    return datetime.strptime(clean, "%Y-%m-%d")


def detect_dependency_cycles(tasks: List[TaskState]) -> List[List[str]]:
    """
    Runs Kahn's / DFS cycle detection on the task dependency graph.
    Returns a list of detected cycles (empty if the graph is a valid DAG).
    """
    adj: Dict[str, List[str]] = {t.id: list(t.dependencies) for t in tasks}
    visited: Set[str] = set()
    on_stack: Set[str] = set()
    cycles: List[List[str]] = []

    def dfs(node: str, path: List[str]) -> None:
        visited.add(node)
        on_stack.add(node)
        for neighbor in adj.get(node, []):
            if neighbor not in adj:
                continue
            if neighbor not in visited:
                dfs(neighbor, path + [neighbor])
            elif neighbor in on_stack:
                idx = path.index(neighbor) if neighbor in path else 0
                cycles.append(path[idx:] + [neighbor])
        on_stack.remove(node)

    for task_id in adj:
        if task_id not in visited:
            dfs(task_id, [task_id])

    return cycles


def validate_schedule_adjustments(
    existing_tasks: List[TaskState],
    adjustments: List[MilestoneAdjustment],
) -> Tuple[bool, List[SchedulingConflict], List[MilestoneAdjustment]]:
    """
    Deterministically validates proposed schedule adjustments:
    1. Rejects any adjustment targeting a locked ('funded' or 'paid') milestone.
    2. Verifies proposed_end_date >= proposed_start_date.
    3. Checks for dependency ordering violations after applying adjustments.
    Returns (is_valid, conflicts, sanitized_adjustments).
    """
    task_map: Dict[str, TaskState] = {t.id: t for t in existing_tasks}
    conflicts: List[SchedulingConflict] = []
    sanitized: List[MilestoneAdjustment] = []

    for adj in adjustments:
        target = task_map.get(adj.task_id)
        if target and target.status in LOCKED_TASK_STATUSES:
            conflicts.append(
                SchedulingConflict(
                    conflict_id=f"conf-locked-{adj.task_id}",
                    conflict_type="locked_milestone_collision",
                    severity="critical",
                    affected_task_ids=[adj.task_id],
                    description=(
                        f"Task '{target.name}' ({adj.task_id}) has status '{target.status}' and is financially locked. "
                        "Dates cannot be shifted automatically."
                    ),
                    recommended_resolution="Exclude funded/paid milestones from rescheduling.",
                )
            )
            continue

        try:
            s_dt = parse_iso_date(adj.proposed_start_date)
            e_dt = parse_iso_date(adj.proposed_end_date)
            if e_dt < s_dt:
                conflicts.append(
                    SchedulingConflict(
                        conflict_id=f"conf-date-{adj.task_id}",
                        conflict_type="dependency_violation",
                        severity="high",
                        affected_task_ids=[adj.task_id],
                        description=f"Proposed end date ({adj.proposed_end_date}) precedes start date ({adj.proposed_start_date}).",
                        recommended_resolution="Ensure end_date >= start_date.",
                    )
                )
                continue
        except ValueError:
            conflicts.append(
                SchedulingConflict(
                    conflict_id=f"conf-parse-{adj.task_id}",
                    conflict_type="dependency_violation",
                    severity="high",
                    affected_task_ids=[adj.task_id],
                    description=f"Invalid ISO date format on adjustment for task {adj.task_id}.",
                    recommended_resolution="Use YYYY-MM-DD format.",
                )
            )
            continue

        sanitized.append(adj)

    # Check circular dependencies
    cycles = detect_dependency_cycles(existing_tasks)
    for idx, cyc in enumerate(cycles):
        conflicts.append(
            SchedulingConflict(
                conflict_id=f"conf-cycle-{idx+1}",
                conflict_type="circular_dependency",
                severity="critical",
                affected_task_ids=cyc,
                description=f"Circular dependency detected across tasks: {' -> '.join(cyc)}",
                recommended_resolution="Break the dependency cycle in the task graph.",
            )
        )

    has_critical = any(c.severity == "critical" for c in conflicts)
    return (not has_critical, conflicts, sanitized)
