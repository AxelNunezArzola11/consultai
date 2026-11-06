"""
Strict Pydantic Models for Project State, Task State, Bryntum Gantt Structures,
and Scheduling Proposals.
"""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Literal, Optional
from pydantic import BaseModel, Field


TaskStatusLiteral = Literal[
    "draft",
    "scheduled",
    "in_progress",
    "funded",
    "in_verification",
    "ready_for_payout",
    "paid",
    "blocked",
    "delayed",
]

RiskSeverityLiteral = Literal["low", "medium", "high", "critical"]


class TaskState(BaseModel):
    """Canonical representation of a project task or milestone shared across Backend, Bryntum, and AG Grid."""

    id: str = Field(..., description="Unique task or milestone UUID/identifier")
    project_id: str = Field(..., description="Parent project UUID")
    name: str = Field(..., min_length=1, max_length=240, description="Task or milestone title")
    description: Optional[str] = Field(default=None, description="Detailed scope or acceptance criteria")
    wbs_code: Optional[str] = Field(default=None, description="Work Breakdown Structure code (e.g., 1.1, 1.2)")
    start_date: str = Field(..., description="ISO-8601 start date (YYYY-MM-DD)")
    end_date: str = Field(..., description="ISO-8601 end/due date (YYYY-MM-DD)")
    duration_days: int = Field(default=1, ge=0, description="Duration in calendar or working days")
    percent_done: int = Field(default=0, ge=0, le=100, description="Completion percentage (0-100)")
    status: TaskStatusLiteral = Field(default="scheduled", description="Lifecycle status of the task/milestone")
    is_milestone: bool = Field(default=False, description="True if zero-duration milestone gate")
    is_critical: bool = Field(default=False, description="True if on the critical path (zero slack)")
    slack_days: int = Field(default=0, description="Total float/slack in days")
    dependencies: List[str] = Field(
        default_factory=list,
        description="List of predecessor task IDs that must finish before this task starts (Finish-to-Start)",
    )
    assigned_consultant_id: Optional[str] = Field(default=None, description="Assigned candidate/consultant ID")
    assigned_consultant_name: Optional[str] = Field(default=None, description="Assigned consultant display name")
    allocated_hours: float = Field(default=8.0, ge=0.0, description="Estimated effort in hours")
    amount_cents: int = Field(default=0, ge=0, description="Milestone budget allocation in cents")
    version: int = Field(default=1, ge=1, description="Optimistic concurrency version counter")
    baseline_start_date: Optional[str] = Field(default=None, description="Baseline start date for variance tracking")
    baseline_end_date: Optional[str] = Field(default=None, description="Baseline end date for variance tracking")


class ProjectRiskItem(BaseModel):
    """Identified project risk with mitigation strategy."""

    risk_id: str = Field(..., description="Unique identifier for the risk")
    category: Literal["schedule", "technical", "financial", "resource", "dependency", "compliance"] = Field(
        default="schedule"
    )
    severity: RiskSeverityLiteral = Field(default="medium")
    title: str = Field(..., description="Concise risk title")
    description: str = Field(..., description="Detailed impact analysis")
    affected_task_ids: List[str] = Field(default_factory=list)
    mitigation_plan: str = Field(..., description="Concrete action to mitigate the risk")


class BryntumTaskNode(BaseModel):
    """Bryntum Gantt compatible task/milestone record."""

    id: str
    name: str
    startDate: str
    endDate: str
    duration: int = Field(default=1, ge=0)
    durationUnit: str = Field(default="day")
    percentDone: int = Field(default=0, ge=0, le=100)
    milestone: bool = Field(default=False)
    critical: bool = Field(default=False)
    manuallyScheduled: bool = Field(default=False)
    readOnly: bool = Field(default=False, description="True when status is funded or paid")
    status: str = Field(default="scheduled")
    wbsCode: Optional[str] = None
    assignedResourceId: Optional[str] = None
    assignedResourceName: Optional[str] = None
    amountCents: int = Field(default=0)
    version: int = Field(default=1)
    note: Optional[str] = None
    baselines: List[Dict[str, str]] = Field(default_factory=list)
    children: Optional[List["BryntumTaskNode"]] = None


class BryntumDependencyNode(BaseModel):
    """Bryntum Gantt compatible dependency edge."""

    id: str
    fromEvent: str
    toEvent: str
    type: int = Field(default=2, description="Bryntum dependency type: 0=SS, 1=SF, 2=FS, 3=FF")
    lag: int = Field(default=0)
    lagUnit: str = Field(default="day")


class BryntumResourceNode(BaseModel):
    """Bryntum Gantt compatible consultant resource."""

    id: str
    name: str
    role: str = Field(default="Consultant")
    email: Optional[str] = None
    availabilityStatus: Literal["available", "partially_allocated", "overallocated", "unavailable"] = Field(
        default="available"
    )
    maxUnits: int = Field(default=100, description="Max allocation percentage (100 = full-time)")
    allocatedTaskCount: int = Field(default=0)
    utilizationPercent: int = Field(default=0, ge=0, le=300)


class BryntumAssignmentNode(BaseModel):
    """Bryntum Gantt resource-to-task assignment record."""

    id: str
    event: str = Field(..., description="Task ID")
    resource: str = Field(..., description="Resource/Consultant ID")
    units: int = Field(default=100, ge=0, le=100, description="Allocation percentage on this task")


class SchedulingConflict(BaseModel):
    """Detected scheduling conflict or constraint violation."""

    conflict_id: str
    conflict_type: Literal[
        "dependency_violation",
        "resource_overallocation",
        "locked_milestone_collision",
        "deadline_overrun",
        "circular_dependency",
    ]
    severity: RiskSeverityLiteral = Field(default="high")
    affected_task_ids: List[str] = Field(default_factory=list)
    affected_resource_id: Optional[str] = None
    description: str
    recommended_resolution: str


class MilestoneAdjustment(BaseModel):
    """Single task/milestone scheduling adjustment inside a SchedulingProposal."""

    task_id: str = Field(..., description="Target milestone/task ID")
    task_name: str = Field(..., description="Target milestone/task name")
    previous_start_date: str = Field(..., description="Original start date (YYYY-MM-DD)")
    previous_end_date: str = Field(..., description="Original end date (YYYY-MM-DD)")
    proposed_start_date: str = Field(..., description="Proposed new start date (YYYY-MM-DD)")
    proposed_end_date: str = Field(..., description="Proposed new end date (YYYY-MM-DD)")
    delta_days: int = Field(..., description="Shift in days (+ for delay, - for acceleration)")
    expected_version: int = Field(default=1, ge=1, description="Optimistic concurrency version")
    reason: str = Field(..., description="Specific dependency or delay reason for this shift")


class SchedulingProposal(BaseModel):
    """
    Validated AI scheduling proposal returned by Planning Agent or Reschedule Agent.
    Never mutates the project schedule directly without explicit human authorization.
    """

    proposal_id: str = Field(..., description="Unique scheduling proposal ID")
    project_id: str = Field(..., description="Target project ID")
    execution_id: Optional[str] = Field(default=None, description="Originating agent execution ID")
    proposed_by_agent: Literal["planning_agent", "reschedule_agent"] = Field(default="reschedule_agent")
    status: Literal["pending_approval", "approved", "rejected", "superseded"] = Field(default="pending_approval")
    overall_risk: RiskSeverityLiteral = Field(default="medium")
    total_delay_days: int = Field(default=0)
    rationale: str = Field(..., description="Executive explanation of proposed schedule changes")
    adjustments: List[MilestoneAdjustment] = Field(default_factory=list)
    conflicts_resolved: List[SchedulingConflict] = Field(default_factory=list)
    bryntum_tasks_preview: List[BryntumTaskNode] = Field(default_factory=list)
    bryntum_dependencies_preview: List[BryntumDependencyNode] = Field(default_factory=list)
    requires_human_approval: bool = Field(default=True)
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class ProjectState(BaseModel):
    """Comprehensive project state snapshot shared across multi-agent workflows."""

    project_id: str
    title: str
    brief: str
    status: Literal["draft", "active", "completed", "disputed"] = Field(default="active")
    total_budget_cents: int = Field(default=0, ge=0)
    allocated_budget_cents: int = Field(default=0, ge=0)
    paid_budget_cents: int = Field(default=0, ge=0)
    tasks: List[TaskState] = Field(default_factory=list)
    dependencies: List[BryntumDependencyNode] = Field(default_factory=list)
    resources: List[BryntumResourceNode] = Field(default_factory=list)
    assignments: List[BryntumAssignmentNode] = Field(default_factory=list)
    conflicts: List[SchedulingConflict] = Field(default_factory=list)
    critical_path_task_ids: List[str] = Field(default_factory=list)
    health_score: int = Field(default=100, ge=0, le=100)
