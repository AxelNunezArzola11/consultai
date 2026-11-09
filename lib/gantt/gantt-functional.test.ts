/**
 * Functional regression tests for the shared Bryntum Gantt contract
 * (lib/gantt/bryntum-config): milestone-diamond rendering predicate,
 * temp-id routing for drops/backlog/seed tasks, and critical-path +
 * dependency feature flags kept consistent across the React wrapper and
 * vanilla Gantt surfaces.
 *
 * Pure unit tests — no DOM, no Bryntum runtime, no database.
 * Complements bryntum-config.test.ts with render-contract edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  BRYNTUM_CRITICAL_PATHS_ENABLED,
  BRYNTUM_DEPENDENCIES_ENABLED,
  bryntumReactFeatureFlags,
  bryntumVanillaFeatureFlags,
  isMilestoneTask,
  isTempTaskId,
} from "./bryntum-config";

describe("milestone render predicate (diamond gates)", () => {
  it("flags and non-positive durations render as milestones", () => {
    expect(isMilestoneTask({ milestone: true })).toBe(true);
    expect(isMilestoneTask({ milestone: true, duration: 10 })).toBe(true);
    expect(isMilestoneTask({ duration: 0 })).toBe(true);
    expect(isMilestoneTask({ duration: -3 })).toBe(true);
  });

  it("same-day windows render as milestones, including datetime stamps", () => {
    expect(isMilestoneTask({ startDate: "2026-03-02", endDate: "2026-03-02" })).toBe(true);
    expect(
      isMilestoneTask({ startDate: "2026-03-02T09:00:00Z", endDate: "2026-03-02T17:30:00Z" })
    ).toBe(true);
  });

  it("multi-day spans with no flag render as bars, not diamonds", () => {
    expect(
      isMilestoneTask({ milestone: false, duration: 4, startDate: "2026-03-02", endDate: "2026-03-06" })
    ).toBe(false);
    expect(isMilestoneTask({ duration: 2, startDate: "2026-03-02", endDate: "2026-03-04" })).toBe(false);
    expect(isMilestoneTask({})).toBe(false);
    expect(isMilestoneTask({ milestone: null, duration: null, startDate: null, endDate: null })).toBe(
      false
    );
  });

  it("partial date information never renders a milestone by itself", () => {
    expect(isMilestoneTask({ duration: 2, startDate: "2026-03-02" })).toBe(false);
    expect(isMilestoneTask({ duration: 2, endDate: "2026-03-02" })).toBe(false);
  });
});

describe("temp-id routing (drops / backlog / seed have no DB row yet)", () => {
  it("classifies client temp ids across every creation path", () => {
    for (const id of ["seed-1", "dropped-uuid-7", "u-backlog-3", "task-ad-hoc-9"]) {
      expect(isTempTaskId(id)).toBe(true);
    }
    expect(isTempTaskId(null)).toBe(true);
    expect(isTempTaskId(undefined)).toBe(true);
    expect(isTempTaskId("")).toBe(true);
  });

  it("accepts server-issued ids (never routes them through the create path)", () => {
    for (const id of [
      "demo-ms-requirements",
      "proj-alpha_m3abc",
      "550e8400-e29b-41d4-a716-446655440000",
      42,
    ]) {
      expect(isTempTaskId(id)).toBe(false);
    }
  });
});

describe("critical path + dependency flags (both surfaces agree)", () => {
  it("canonical flags are ON", () => {
    expect(BRYNTUM_CRITICAL_PATHS_ENABLED).toBe(true);
    expect(BRYNTUM_DEPENDENCIES_ENABLED).toBe(true);
  });

  it("React wrapper and vanilla constructor stay consistent", () => {
    const react = bryntumReactFeatureFlags();
    const vanilla = bryntumVanillaFeatureFlags();
    expect(react.criticalPathsFeature).toEqual({ disabled: false });
    expect(react.dependenciesFeature).toEqual({ disabled: false });
    expect(vanilla.criticalPaths).toBe(true);
    expect(vanilla.dependencies).toBe(true);
    // The user toggle only flips critical paths; dependencies stay wired.
    expect(bryntumReactFeatureFlags(false).criticalPathsFeature).toEqual({ disabled: true });
    expect(bryntumReactFeatureFlags(false).dependenciesFeature).toEqual({ disabled: false });
  });
});
