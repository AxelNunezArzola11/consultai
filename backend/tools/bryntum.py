"""
Bryntum Gantt Deterministic Task Graph Builder, Critical Path Calculator,
Resource Workload Analyzer, and Reschedule Engine.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

from backend.policies.validation import LOCKED_TASK_STATUSES, parse_iso_date
from backend.schemas.tasks import (
    BryntumAssignmentNode,
    BryntumDependencyNode,
    BryntumResourceNode,
    BryntumTaskNode,
    MilestoneAdjustment,
    SchedulingConflict,
    TaskState,
)


def compute_critical_path_and_slack(tasks: List[TaskState]) -> Tuple[List[TaskState], List[str]]:
    """
    Computes forward/backward pass over the task graph to identify critical path tasks
    and populate slack_days & is_critical on each TaskState.
    """
    if not tasks:
        return [], []

    task_map: Dict[str, TaskState] = {t.id: t.model_copy(deep=True) for t in tasks}
    successors: Dict[str, List[str]] = {t.id: [] for t in tasks}
    for t in tasks:
        for dep_id in t.dependencies:
            if dep_id in successors:
                successors[dep_id].append(t.id)

    end_dates: Dict[str, datetime] = {}
    start_dates: Dict[str, datetime] = {}
    for t in tasks:
        try:
            start_dates[t.id] = parse_iso_date(t.start_date)
        except ValueError:
            start_dates[t.id] = datetime.utcnow()
        try:
            end_dates[t.id] = parse_iso_date(t.end_date)
        except ValueError:
            end_dates[t.id] = start_dates[t.id] + timedelta(days=max(1, t.duration_days))

    project_max_end = max(end_dates.values()) if end_dates else datetime.utcnow()
    critical_ids: List[str] = []

    for tid, t in task_map.items():
        succs = successors.get(tid, [])
        if not succs:
            slack = max(0, (project_max_end - end_dates[tid]).days)
        else:
            earliest_succ_start = min(start_dates[s] for s in succs)
            slack = max(0, (earliest_succ_start - end_dates[tid]).days)

        t.slack_days = slack
        t.is_critical = slack <= 1 or len(succs) > 0 and slack == 0
        if t.is_critical:
            critical_ids.append(tid)

    # Ensure at least the longest chain or final milestone is marked critical
    if not critical_ids and tasks:
        latest_task = max(tasks, key=lambda item: end_dates.get(item.id, datetime.min))
        task_map[latest_task.id].is_critical = True
        critical_ids.append(latest_task.id)

    return list(task_map.values()), critical_ids


def detect_resource_and_schedule_conflicts(tasks: List[TaskState]) -> List[SchedulingConflict]:
    """
    Scans tasks for:
    1. Dependency violations (task starts before predecessor finishes).
    2. Resource overallocation (same consultant assigned to overlapping tasks).
    """
    conflicts: List[SchedulingConflict] = []
    task_map = {t.id: t for t in tasks}

    # 1. Dependency violations
    for t in tasks:
        try:
            t_start = parse_iso_date(t.start_date)
        except ValueError:
            continue
        for pred_id in t.dependencies:
            pred = task_map.get(pred_id)
            if not pred:
                continue
            try:
                pred_end = parse_iso_date(pred.end_date)
                if t_start < pred_end:
                    conflicts.append(
                        SchedulingConflict(
                            conflict_id=f"conf-dep-{pred_id}-{t.id}",
                            conflict_type="dependency_violation",
                            severity="high",
                            affected_task_ids=[pred_id, t.id],
                            description=(
                                f"Task '{t.name}' starts on {t.start_date}, before predecessor "
                                f"'{pred.name}' finishes on {pred.end_date}."
                            ),
                            recommended_resolution=f"Shift '{t.name}' start date to at least {pred.end_date}.",
                        )
                    )
            except ValueError:
                continue

    # 2. Consultant overlap
    by_consultant: Dict[str, List[TaskState]] = {}
    for t in tasks:
        if t.assigned_consultant_id and t.status != "paid":
            by_consultant.setdefault(t.assigned_consultant_id, []).append(t)

    for cid, c_tasks in by_consultant.items():
        if len(c_tasks) < 2:
            continue
        sorted_tasks = sorted(c_tasks, key=lambda x: x.start_date)
        for i in range(len(sorted_tasks) - 1):
            curr = sorted_tasks[i]
            nxt = sorted_tasks[i + 1]
            try:
                curr_end = parse_iso_date(curr.end_date)
                nxt_start = parse_iso_date(nxt.start_date)
                if nxt_start < curr_end:
                    c_name = curr.assigned_consultant_name or cid
                    conflicts.append(
                        SchedulingConflict(
                            conflict_id=f"conf-res-{cid}-{curr.id}-{nxt.id}",
                            conflict_type="resource_overallocation",
                            severity="medium",
                            affected_task_ids=[curr.id, nxt.id],
                            affected_resource_id=cid,
                            description=(
                                f"Consultant '{c_name}' has overlapping assignments: "
                                f"'{curr.name}' (ends {curr.end_date}) and '{nxt.name}' (starts {nxt.start_date})."
                            ),
                            recommended_resolution=f"Stagger '{nxt.name}' or reassign to another available consultant.",
                        )
                    )
            except ValueError:
                continue

    return conflicts


def build_bryntum_project_model(
    tasks: List[TaskState],
    consultants: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[
    List[BryntumTaskNode],
    List[BryntumDependencyNode],
    List[BryntumResourceNode],
    List[BryntumAssignmentNode],
]:
    """
    Converts canonical TaskState records and consultant profiles into Bryntum Gantt structures:
    (bryntum_tasks, bryntum_dependencies, bryntum_resources, bryntum_assignments).
    """
    enriched_tasks, _ = compute_critical_path_and_slack(tasks)
    bryntum_tasks: List[BryntumTaskNode] = []
    bryntum_deps: List[BryntumDependencyNode] = []
    bryntum_assignments: List[BryntumAssignmentNode] = []
    workload_counts: Dict[str, int] = {}

    for idx, t in enumerate(enriched_tasks):
        wbs = t.wbs_code or f"1.{idx + 1}"
        try:
            s_dt = parse_iso_date(t.start_date)
            e_dt = parse_iso_date(t.end_date)
            duration = max(0 if t.is_milestone else 1, (e_dt - s_dt).days)
        except ValueError:
            duration = t.duration_days

        baselines = []
        if t.baseline_start_date and t.baseline_end_date:
            baselines.append({"startDate": t.baseline_start_date, "endDate": t.baseline_end_date})
        else:
            baselines.append({"startDate": t.start_date, "endDate": t.end_date})

        bryntum_tasks.append(
            BryntumTaskNode(
                id=t.id,
                name=t.name,
                startDate=t.start_date,
                endDate=t.end_date,
                duration=duration,
                percentDone=t.percent_done,
                milestone=t.is_milestone,
                critical=t.is_critical,
                manuallyScheduled=False,
                readOnly=t.status in LOCKED_TASK_STATUSES,
                status=t.status,
                wbsCode=wbs,
                assignedResourceId=t.assigned_consultant_id,
                assignedResourceName=t.assigned_consultant_name,
                amountCents=t.amount_cents,
                version=t.version,
                note=t.description,
                baselines=baselines,
            )
        )

        for dep_id in t.dependencies:
            bryntum_deps.append(
                BryntumDependencyNode(
                    id=f"dep-{dep_id}-{t.id}",
                    fromEvent=dep_id,
                    toEvent=t.id,
                    type=2,
                )
            )

        if t.assigned_consultant_id:
            workload_counts[t.assigned_consultant_id] = workload_counts.get(t.assigned_consultant_id, 0) + 1
            bryntum_assignments.append(
                BryntumAssignmentNode(
                    id=f"asgn-{t.id}-{t.assigned_consultant_id}",
                    event=t.id,
                    resource=t.assigned_consultant_id,
                    units=100,
                )
            )

    bryntum_resources: List[BryntumResourceNode] = []
    seen_res: Set[str] = set()
    for c in consultants or []:
        cid = str(c.get("id") or "")
        if not cid or cid in seen_res:
            continue
        seen_res.add(cid)
        count = workload_counts.get(cid, 0)
        utilization = min(200, count * 50)
        avail: Any = (
            "overallocated"
            if utilization > 100
            else ("partially_allocated" if utilization > 0 else "available")
        )
        bryntum_resources.append(
            BryntumResourceNode(
                id=cid,
                name=str(c.get("name") or cid),
                role=str(c.get("role") or "Consultant"),
                email=c.get("email"),
                availabilityStatus=avail,
                maxUnits=100,
                allocatedTaskCount=count,
                utilizationPercent=utilization,
            )
        )

    return bryntum_tasks, bryntum_deps, bryntum_resources, bryntum_assignments


def calculate_reschedule_cascade(
    tasks: List[TaskState],
    delayed_task_id: Optional[str],
    delay_days: int,
    delay_reason: str,
) -> Tuple[List[MilestoneAdjustment], List[TaskState]]:
    """
    Deterministically propagates a schedule shift of `delay_days` starting from `delayed_task_id`
    through all transitive downstream dependent tasks, skipping any financially locked ('funded'/'paid') tasks.
    """
    if not tasks:
        return [], []

    task_map: Dict[str, TaskState] = {t.id: t.model_copy(deep=True) for t in tasks}
    target_id = delayed_task_id or (tasks[0].id if tasks else None)
    if not target_id or target_id not in task_map:
        target_id = tasks[0].id

    # Find transitive closure of dependents
    affected_order: List[str] = []
    visited: Set[str] = set()

    def collect_downstream(tid: str) -> None:
        if tid in visited:
            return
        visited.add(tid)
        affected_order.append(tid)
        for candidate in tasks:
            if tid in candidate.dependencies:
                collect_downstream(candidate.id)

    collect_downstream(target_id)

    adjustments: List[MilestoneAdjustment] = []
    for tid in affected_order:
        t = task_map[tid]
        if t.status in LOCKED_TASK_STATUSES:
            continue
        try:
            old_start = parse_iso_date(t.start_date)
            old_end = parse_iso_date(t.end_date)
        except ValueError:
            continue

        new_start = (old_start + timedelta(days=delay_days)).strftime("%Y-%m-%d")
        new_end = (old_end + timedelta(days=delay_days)).strftime("%Y-%m-%d")

        reason_str = (
            f"Direct delay ({delay_days:+d}d): {delay_reason}"
            if tid == target_id
            else f"CascadedFinish-to-Start dependency shift ({delay_days:+d}d) from upstream task '{task_map[target_id].name}'"
        )
        adjustments.append(
            MilestoneAdjustment(
                task_id=t.id,
                task_name=t.name,
                previous_start_date=t.start_date[:10],
                previous_end_date=t.end_date[:10],
                proposed_start_date=new_start,
                proposed_end_date=new_end,
                delta_days=delay_days,
                expected_version=t.version,
                reason=reason_str,
            )
        )
        t.start_date = new_start
        t.end_date = new_end

    return adjustments, list(task_map.values())
