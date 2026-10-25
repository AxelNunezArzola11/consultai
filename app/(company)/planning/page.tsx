/**
 * Project Planning — Server Component (route: /planning)
 *
 * This page is intentionally isolated from the main /dashboard route.
 * It:
 *   1. Fetches project / milestone data from the DB.
 *   2. Shapes it into GanttTask[] + GanttDependency[].
 *   3. Passes the result to <PlanningLayout> — a "use client" component that
 *      renders the split-screen layout:
 *
 *        ┌────────────────────┬──────────────────────────────────┐
 *        │  Unscheduled Tasks │  Bryntum Gantt (Project Plan)    │
 *        │  (AG Grid)         │                                  │
 *        └────────────────────┴──────────────────────────────────┘
 *
 *      PlanningLayout owns the Bryntum DragHelper and all cross-component
 *      drag-and-drop state.  Bryntum-specific imports live exclusively inside
 *      that component tree (ssr: false boundary).
 *
 * No @bryntum/* imports happen here — only data fetching and shaping.
 */
import type { GanttTask, GanttDependency } from "@/components/bryntum-gantt/BryntumGantt";
import PlanningLayout, {
  type PlanningLayoutProps,
} from "@/components/bryntum-gantt/PlanningLayout";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Data shaping helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape DB milestone rows into the flat GanttTask format.
 *
 * Replace the body of this function once the Gantt-specific DB columns
 * (start_date, gantt_order, parent_task_id) are populated by the migration
 * in lib/db/migrations/0007_step3_gantt_start_date_version.sql.
 */
function buildGanttTasks(): GanttTask[] {
  // TODO: map real DB rows once the schema is extended.
  // Example mapping:
  //   return rows.map((m) => ({
  //     id:          m.id,
  //     name:        m.title,
  //     startDate:   m.startDate ?? new Date().toISOString().slice(0, 10),
  //     duration:    m.durationDays ?? 3,
  //     percentDone: m.percentDone ?? 0,
  //     parentId:    m.parentTaskId ?? null,
  //   }));

  // Return empty array so the client component renders its default seed data.
  return [];
}

/**
 * Build dependency records from task relationships.
 *
 * Replace once inter-task dependencies are stored in the DB.
 */
function buildGanttDependencies(): GanttDependency[] {
  // TODO: fetch dependency rows from a dedicated table.
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default async function PlanningPage() {
  // ── 1. Fetch data (replace with real queries) ──────────────────────────────
  // const milestoneRows   = await db.select().from(milestones).limit(500);
  // const dependencyRows  = ...
  const milestoneRows:  unknown[] = [];
  const dependencyRows: unknown[] = [];

  // ── 2. Shape data ──────────────────────────────────────────────────────────
  const tasks        = buildGanttTasks();
  const dependencies = buildGanttDependencies();

  // ── 3. Build props for the client layout ───────────────────────────────────
  const layoutProps: PlanningLayoutProps = {
    initialTasks:        tasks.length > 0        ? tasks        : undefined,
    initialDependencies: dependencies.length > 0 ? dependencies : undefined,
  };

  // ── 4. Render ──────────────────────────────────────────────────────────────
  // Only plain serialisable props cross the server → client boundary.
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-slate-950">
      <PlanningLayout {...layoutProps} />
    </div>
  );
}
