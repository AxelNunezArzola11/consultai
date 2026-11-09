/**
 * Project Planning — Server Component (route: /planning)
 *
 * Connects Bryntum Gantt and AG Grid Unscheduled Tasks directly to the shared
 * Neon PostgreSQL project, milestone, candidate, and scheduling_proposals tables.
 */
import type {
  GanttTask,
  GanttDependency,
  GanttConsultantResource,
  SchedulingProposalPreview,
} from "@/components/bryntum-gantt/BryntumGantt";
import PlanningLayout, {
  type PlanningLayoutProps,
  type PlanningProjectOption,
} from "@/components/bryntum-gantt/PlanningLayout";
import { db } from "@/lib/db";
import {
  projects,
  milestones,
  candidates,
  schedulingProposals,
} from "@/lib/db/schema";
import { ensureAiOpsTables } from "@/lib/ai-ops/orchestrator-engine";
import { desc, eq } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { requirePageRole, requireProjectAccess, scopedCompanyId } from "@/lib/auth/guards";
import { isMilestoneTask } from "@/lib/gantt/bryntum-config";

export const dynamic = "force-dynamic";

function daysBetween(startIso: string, endIso: string): number {
  const s = new Date(`${startIso.slice(0, 10)}T00:00:00Z`).getTime();
  const e = new Date(`${endIso.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return 4;
  return Math.max(1, Math.round((e - s) / 86400000));
}

// Module scope (outside render): default schedule anchor per milestone index.
// Math is unchanged from the inline expression it replaces.
function defaultStartForIndex(idx: number): string {
  return new Date(Date.now() + idx * 5 * 86400000)
    .toISOString()
    .slice(0, 10);
}

export default async function PlanningPage({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string }>;
}) {
  const resolvedParams = searchParams ? await searchParams : {};
  // Authenticate + authorize BEFORE querying/rendering (demo bypass: fixtures only).
  const auth = await requirePageRole(["company", "admin"]);
  const scope = scopedCompanyId(auth);
  if (!auth.demoBypass && scope && resolvedParams.projectId) {
    // Explicit project param: verify ownership before any query (cross-company -> notFound).
    await requireProjectAccess(resolvedParams.projectId);
  }
  let projectOptions: PlanningProjectOption[] = [];
  let selectedProjectId: string | undefined = resolvedParams.projectId;
  let tasks: GanttTask[] | undefined;
  let dependencies: GanttDependency[] | undefined;
  let consultantResources: GanttConsultantResource[] = [];
  let initialProposal: SchedulingProposalPreview | null = null;
  let loadError: string | null = null;

  try {
    await ensureAiOpsTables();
    const demoTables = isDemoMode() ? getDemoTables() : null;
    const allProjects = demoTables
      ? [...demoTables.projects]
          .sort((a, b) => +b.createdAt - +a.createdAt)
          .slice(0, 30)
      : scope
        ? await db
            .select()
            .from(projects)
            .where(eq(projects.companyId, scope))
            .orderBy(desc(projects.createdAt))
            .limit(30)
        : await db
            .select()
            .from(projects)
            .orderBy(desc(projects.createdAt))
            .limit(30);

    projectOptions = allProjects.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
    }));

    if (!selectedProjectId && allProjects.length > 0) {
      selectedProjectId = allProjects[0].id;
    }

    if (selectedProjectId) {
      const [projMilestones, projCandidates, pendingProposals] = demoTables
        ? [
            demoTables.milestones
              .filter((m) => m.projectId === selectedProjectId)
              .sort((a, b) => a.position - b.position),
            demoTables.candidates
              .filter((c) => c.projectId === selectedProjectId)
              .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
            demoTables.schedulingProposals
              .filter((p) => p.projectId === selectedProjectId)
              .sort((a, b) => +b.createdAt - +a.createdAt)
              .slice(0, 5),
          ]
        : await Promise.all([
            db
              .select()
              .from(milestones)
              .where(eq(milestones.projectId, selectedProjectId))
              .orderBy(milestones.position),
            db
              .select()
              .from(candidates)
              .where(eq(candidates.projectId, selectedProjectId))
              .orderBy(candidates.rank),
            db
              .select()
              .from(schedulingProposals)
              .where(eq(schedulingProposals.projectId, selectedProjectId))
              .orderBy(desc(schedulingProposals.createdAt))
              .limit(5)
              .catch(() => []),
          ]);

      consultantResources = projCandidates.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        status: c.status,
        trustScore: c.trustScore ? parseFloat(c.trustScore) : undefined,
      }));

      const today = new Date().toISOString().slice(0, 10);
      tasks = projMilestones.map((m, idx) => {
        const defaultStart = defaultStartForIndex(idx);
        const startDate = m.startDate ?? defaultStart;
        const endDate =
          m.dueDate ??
          new Date(new Date(`${startDate}T00:00:00Z`).getTime() + 5 * 86400000)
            .toISOString()
            .slice(0, 10);
        const duration = daysBetween(startDate, endDate);
        const percentDone =
          m.status === "paid"
            ? 100
            : m.status === "verifying" || m.status === "pending_approval"
            ? 80
            : m.status === "submitted"
            ? 65
            : m.status === "funded"
            ? 45
            : 15;

        const assignedCandidate =
          projCandidates.length > 0
            ? projCandidates[idx % projCandidates.length]
            : null;

        return {
          id: m.id,
          name: m.title,
          startDate,
          endDate,
          duration,
          percentDone,
          parentId: null,
          status: m.status,
          budgetUsd: parseFloat(m.budgetUsd || "0"),
          assignedConsultantId: assignedCandidate?.id ?? null,
          assignedConsultantName: assignedCandidate?.name ?? null,
          milestone: isMilestoneTask({ duration, startDate, endDate }),
          readOnly: m.status === "funded" || m.status === "paid",
          version: m.version,
          baselines: [{ startDate: startDate || today, endDate }],
        };
      });

      // Finish-to-Start dependencies ONLY from explicit dependsOnId.
      // No sequential fallback: invented links corrupt the critical path.
      dependencies = [];
      const milestoneIds = new Set(projMilestones.map((m) => m.id));
      for (const m of projMilestones) {
        if (m.dependsOnId && milestoneIds.has(m.dependsOnId)) {
          dependencies.push({
            id: `dep-${m.dependsOnId}-${m.id}`,
            fromTask: m.dependsOnId,
            toTask: m.id,
            type: 2,
          });
        }
      }

      const activeProp = pendingProposals.find(
        (p) => p.status === "pending_approval"
      );
      if (activeProp) {
        initialProposal = {
          proposal_id: activeProp.id,
          project_id: activeProp.projectId,
          execution_id: activeProp.executionId ?? undefined,
          proposed_by_agent: activeProp.proposedByAgent,
          overall_risk: activeProp.overallRisk,
          total_delay_days: activeProp.totalDelayDays,
          rationale: activeProp.rationale,
          status: activeProp.status,
          adjustments: Array.isArray(activeProp.adjustments)
            ? (activeProp.adjustments as SchedulingProposalPreview["adjustments"])
            : [],
        };
      }
    }
  } catch (err) {
    // Honest error state: surface the failure, never silent seed data.
    console.warn("[/planning] Database query failed:", err);
    loadError =
      err instanceof Error
        ? `Could not load the project schedule: ${err.message}`
        : "Could not load the project schedule.";
  }

  // No-project / zero-milestone success path renders the empty panel (never seed).
  if (!loadError) {
    tasks ??= [];
    dependencies ??= [];
  }

  const layoutProps: PlanningLayoutProps = {
    projectId: selectedProjectId,
    projectOptions,
    initialTasks: tasks,
    initialDependencies: dependencies,
    initialConsultants: consultantResources,
    initialProposal,
    loadError,
  };

  return (
    <div className="flex min-h-[calc(100vh-80px)] min-w-0 flex-1 overflow-hidden bg-slate-950">
      <PlanningLayout {...layoutProps} />
    </div>
  );
}
