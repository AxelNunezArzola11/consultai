import { describe, expect, it } from "vitest";
import {
  BRYNTUM_CRITICAL_PATHS_ENABLED,
  BRYNTUM_DEPENDENCIES_ENABLED,
  bryntumReactFeatureFlags,
  bryntumVanillaFeatureFlags,
  isMilestoneTask,
  isTempTaskId,
} from "./bryntum-config";

describe("bryntum shared config", () => {
  it("enables critical paths and dependencies on both surfaces", () => {
    expect(BRYNTUM_CRITICAL_PATHS_ENABLED).toBe(true);
    expect(BRYNTUM_DEPENDENCIES_ENABLED).toBe(true);
    expect(bryntumReactFeatureFlags(true)).toEqual({
      criticalPathsFeature: { disabled: false },
      dependenciesFeature: { disabled: false },
    });
    expect(bryntumReactFeatureFlags(false).criticalPathsFeature).toEqual({ disabled: true });
    const vanilla = bryntumVanillaFeatureFlags();
    expect(vanilla.criticalPaths).toBe(true);
    expect(vanilla.dependencies).toBe(true);
    expect(vanilla.taskEdit).toBe(false);
  });

  it("detects milestones by flag, zero duration, or same-day window", () => {
    expect(isMilestoneTask({ milestone: true, duration: 5 })).toBe(true);
    expect(isMilestoneTask({ duration: 0 })).toBe(true);
    expect(isMilestoneTask({ duration: -1 })).toBe(true);
    expect(isMilestoneTask({ startDate: "2025-06-01", endDate: "2025-06-01" })).toBe(true);
    expect(isMilestoneTask({ duration: 3, startDate: "2025-06-01", endDate: "2025-06-04" })).toBe(false);
    expect(isMilestoneTask({})).toBe(false);
  });

  it("classifies temp ids that have no DB row yet", () => {
    for (const id of ["seed-1", "dropped-3", "u-9", "task-1234567890", "", null, undefined]) {
      expect(isTempTaskId(id)).toBe(true);
    }
    for (const id of ["proj-1_m1", "ms_abc123", "550e8400-e29b-41d4-a716-446655440000"]) {
      expect(isTempTaskId(id)).toBe(false);
    }
  });
});
