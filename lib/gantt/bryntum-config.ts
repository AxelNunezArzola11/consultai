/**
 * Shared Bryntum Gantt configuration — single source of truth for the two
 * Gantt surfaces (BryntumGantt.tsx React wrapper + GanttPanel.tsx vanilla).
 *
 * Both surfaces must agree on critical-path highlighting and dependency-line
 * rendering; diverging flags were the source of the critical-path /
 * dependency-line inconsistency. Import from here instead of hardcoding
 * feature flags in either component.
 */

/** Critical-path highlighting is canonical ON (user-toggleable at runtime). */
export const BRYNTUM_CRITICAL_PATHS_ENABLED = true;

/** Dependency lines + dependency store are canonical ON. */
export const BRYNTUM_DEPENDENCIES_ENABLED = true;

/** Feature props for the @bryntum/gantt-react wrapper. */
export function bryntumReactFeatureFlags(criticalPathsEnabled: boolean = BRYNTUM_CRITICAL_PATHS_ENABLED) {
  return {
    criticalPathsFeature: { disabled: !criticalPathsEnabled },
    dependenciesFeature: { disabled: !BRYNTUM_DEPENDENCIES_ENABLED },
  };
}

/** Feature map for the vanilla `new Gantt({ features })` constructor. */
export function bryntumVanillaFeatureFlags() {
  return {
    taskEdit: false,
    projectLines: false,
    criticalPaths: BRYNTUM_CRITICAL_PATHS_ENABLED,
    rollups: false,
    percentBar: false,
    dependencies: BRYNTUM_DEPENDENCIES_ENABLED,
  };
}

/**
 * Canonical milestone predicate (Bryntum renders zero-duration tasks as
 * diamond gates). A task is a milestone when it is explicitly flagged, has
 * zero/negative duration, or starts and ends on the same date-only day.
 */
export function isMilestoneTask(t: {
  duration?: number | null;
  milestone?: boolean | null;
  startDate?: string | null;
  endDate?: string | null;
}): boolean {
  if (t.milestone === true) return true;
  if (typeof t.duration === "number" && t.duration <= 0) return true;
  if (t.startDate && t.endDate && t.startDate.slice(0, 10) === t.endDate.slice(0, 10)) return true;
  return false;
}

const TEMP_ID_PREFIXES = ["seed-", "dropped-", "u-", "task-"];

/** Client-side temp ids that have no DB row yet (seed, drops, backlog, ad-hoc). */
export function isTempTaskId(id: string | number | null | undefined): boolean {
  if (id === null || id === undefined) return true;
  const s = String(id);
  if (s.length === 0) return true;
  return TEMP_ID_PREFIXES.some((p) => s.startsWith(p));
}
