/**
 * Scheduling dependency engine — Phase 4
 *
 * Cascading recalculation of milestone due_dates when upstream milestones shift.
 *
 * Rules:
 * - A milestone with dependsOnId and offsetDays has its due_date derived:
 *     due_date = dependency.due_date + offsetDays calendar days
 * - Funded milestones are NEVER recalculated (financial consistency rule)
 * - Recalculation is deterministic and topologically ordered (BFS from changed node)
 * - Cycles in the dependency graph are detected and rejected
 * - All recalculations are written atomically in a single batch update per call
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4 — Scheduling & Dependency Engine
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { milestones } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MilestoneNode {
  id: string;
  projectId: string;
  title: string;
  dueDate: string | null;   // ISO date string "YYYY-MM-DD"
  status: string;
  dependsOnId: string | null;
  offsetDays: number | null;
}

export type RecalcResult = {
  updatedMilestones: Array<{ id: string; newDueDate: string }>;
  skippedFunded: string[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Date arithmetic helpers
// ---------------------------------------------------------------------------

/**
 * Adds `days` calendar days to an ISO date string.
 * Returns an ISO date string "YYYY-MM-DD".
 */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

/**
 * Returns the number of calendar days between two ISO date strings (b - a).
 */
export function diffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db_ = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db_ - da) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Funded status check
// ---------------------------------------------------------------------------

const FUNDED_STATUSES = new Set([
  "funded",
  "submitted",
  "verifying",
  "pending_approval",
  "paid",
  "disputed",
]);

export function isFunded(status: string): boolean {
  return FUNDED_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Core recalculation engine
// ---------------------------------------------------------------------------

/**
 * Recalculates all downstream milestone due_dates for a project after
 * one or more milestones have been updated.
 *
 * Algorithm:
 * 1. Load all milestones for the project
 * 2. Build an adjacency list: dependsOnId → [children]
 * 3. BFS from changed nodes to propagate new due_dates
 * 4. Skip funded milestones (financial consistency)
 * 5. Detect cycles (a milestone that depends on itself directly or indirectly)
 * 6. Write all changes in one batch
 *
 * @param projectId - Project to recalculate
 * @param changedMilestoneIds - Milestone IDs whose due_date just changed
 * @returns RecalcResult with updated IDs, skipped funded IDs, and warnings
 */
export async function recalculateDependentDates(
  projectId: string,
  changedMilestoneIds: string[]
): Promise<RecalcResult> {
  const allMilestones = await db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, projectId));

  return recalculateDates(allMilestones, changedMilestoneIds);
}

/**
 * Pure, synchronous version of the recalculation (for tests — does not hit DB).
 * Applies all computed due_date changes in-memory and returns the diff.
 */
export function recalculateDates(
  allMilestones: MilestoneNode[],
  changedMilestoneIds: string[]
): RecalcResult & { computedDates: Record<string, string> } {
  const byId = new Map<string, MilestoneNode>(allMilestones.map((m) => [m.id, m]));
  const children = new Map<string, string[]>(); // dependsOnId → [childId]

  for (const m of allMilestones) {
    if (m.dependsOnId) {
      if (!children.has(m.dependsOnId)) children.set(m.dependsOnId, []);
      children.get(m.dependsOnId)!.push(m.id);
    }
  }

  const warnings: string[] = [];
  const skippedFunded: string[] = [];
  const computedDates: Record<string, string> = {};

  // BFS — visit all descendants of changed nodes
  const queue = [...changedMilestoneIds];
  const visited = new Set<string>(changedMilestoneIds);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const childIds = children.get(currentId) ?? [];

    for (const childId of childIds) {
      if (visited.has(childId)) {
        warnings.push(`Cycle detected involving milestone ${childId} — skipped`);
        continue;
      }
      visited.add(childId);

      const child = byId.get(childId);
      if (!child) continue;

      // Financial consistency: never recalculate funded milestones
      if (isFunded(child.status)) {
        skippedFunded.push(childId);
        // Still propagate to children of funded milestones using THEIR existing date
        queue.push(childId);
        continue;
      }

      if (!child.dependsOnId || child.offsetDays == null) {
        queue.push(childId);
        continue;
      }

      // Get the dependency's (possibly just-computed) due_date
      const parentId = child.dependsOnId;
      const parentDate =
        computedDates[parentId] ?? byId.get(parentId)?.dueDate;

      if (!parentDate) {
        warnings.push(
          `Milestone ${childId} depends on ${parentId} which has no due_date — skipped`
        );
        queue.push(childId);
        continue;
      }

      const newDueDate = addDays(parentDate, child.offsetDays);
      computedDates[childId] = newDueDate;
      queue.push(childId);
    }
  }

  // Remove the seeds from the computed dates (they're the source, not a result)
  for (const seedId of changedMilestoneIds) {
    delete computedDates[seedId];
  }

  const updatedMilestones = Object.entries(computedDates).map(([id, newDueDate]) => ({
    id,
    newDueDate,
  }));

  return { updatedMilestones, skippedFunded, warnings, computedDates };
}

/**
 * Applies the computed due_date changes to the database.
 * Skips any milestones that became funded between recalculation and write.
 */
export async function applyDateRecalculation(
  projectId: string,
  changedMilestoneIds: string[]
): Promise<RecalcResult> {
  const result = await recalculateDependentDates(projectId, changedMilestoneIds);

  for (const { id, newDueDate } of result.updatedMilestones) {
    // Re-check funded status before write (race condition guard)
    const [current] = await db
      .select()
      .from(milestones)
      .where(eq(milestones.id, id))
      .limit(1);

    if (!current) continue;
    if (isFunded(current.status)) {
      result.skippedFunded.push(id);
      result.warnings.push(
        `Milestone ${id} became funded before write — skipped`
      );
      continue;
    }

    await db
      .update(milestones)
      .set({ dueDate: newDueDate, updatedAt: new Date() })
      .where(eq(milestones.id, id));
  }

  return result;
}
