/**
 * Scheduling dependency engine tests — Phase 4
 */

import { describe, it, expect } from "vitest";
import {
  addDays,
  diffDays,
  isFunded,
  recalculateDates,
  type MilestoneNode,
} from "@/lib/scheduling/dependency-engine";

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

describe("addDays", () => {
  it("adds positive days", () => {
    expect(addDays("2025-01-01", 10)).toBe("2025-01-11");
  });

  it("crosses month boundary", () => {
    expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
  });

  it("crosses year boundary", () => {
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("adds zero days (identity)", () => {
    expect(addDays("2025-06-15", 0)).toBe("2025-06-15");
  });
});

describe("diffDays", () => {
  it("computes difference between dates", () => {
    expect(diffDays("2025-01-01", "2025-01-11")).toBe(10);
    expect(diffDays("2025-01-11", "2025-01-01")).toBe(-10);
  });
});

describe("isFunded", () => {
  it("returns true for funded and post-funded statuses", () => {
    const funded = ["funded", "submitted", "verifying", "pending_approval", "paid", "disputed"];
    for (const s of funded) expect(isFunded(s)).toBe(true);
  });

  it("returns false for planned / cancelled", () => {
    expect(isFunded("planned")).toBe(false);
    expect(isFunded("cancelled")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recalculateDates (pure, in-memory)
// ---------------------------------------------------------------------------

function mkMilestone(overrides: Partial<MilestoneNode> & { id: string }): MilestoneNode {
  return {
    projectId: "proj-1",
    title: overrides.id,
    dueDate: null,
    status: "planned",
    dependsOnId: null,
    offsetDays: null,
    ...overrides,
  };
}

describe("recalculateDates", () => {
  it("propagates a date change through a linear chain", () => {
    const m1 = mkMilestone({ id: "m1", dueDate: "2025-02-01", dependsOnId: null });
    const m2 = mkMilestone({ id: "m2", dueDate: "2025-02-08", dependsOnId: "m1", offsetDays: 7 });
    const m3 = mkMilestone({ id: "m3", dueDate: "2025-02-15", dependsOnId: "m2", offsetDays: 7 });

    // Simulate m1's date being updated to 2025-03-01
    const updated_m1 = { ...m1, dueDate: "2025-03-01" };
    const result = recalculateDates([updated_m1, m2, m3], ["m1"]);

    expect(result.computedDates["m2"]).toBe("2025-03-08");
    expect(result.computedDates["m3"]).toBe("2025-03-15");
    expect(result.updatedMilestones.length).toBe(2);
    expect(result.skippedFunded).toHaveLength(0);
  });

  it("does not recalculate funded milestones", () => {
    const m1 = mkMilestone({ id: "m1", dueDate: "2025-02-01" });
    const m2 = mkMilestone({
      id: "m2",
      dueDate: "2025-02-08",
      dependsOnId: "m1",
      offsetDays: 7,
      status: "funded", // funded — must not be recalculated
    });
    const m3 = mkMilestone({ id: "m3", dueDate: "2025-02-15", dependsOnId: "m2", offsetDays: 7 });

    const updated_m1 = { ...m1, dueDate: "2025-03-01" };
    const result = recalculateDates([updated_m1, m2, m3], ["m1"]);

    expect(result.computedDates["m2"]).toBeUndefined();
    expect(result.skippedFunded).toContain("m2");
    // m3 depends on m2 which was skipped — m3 uses m2's existing date
    expect(result.computedDates["m3"]).toBe("2025-02-15"); // m2 existing date + 7 = 2025-02-22? No — m2 wasn't recalculated, uses existing
  });

  it("stops at a funded node and uses its existing date for downstream", () => {
    const m1 = mkMilestone({ id: "m1", dueDate: "2025-02-01" });
    const m2 = mkMilestone({
      id: "m2",
      dueDate: "2025-04-01", // existing due_date — won't change
      dependsOnId: "m1",
      offsetDays: 7,
      status: "funded",
    });
    const m3 = mkMilestone({ id: "m3", dueDate: null, dependsOnId: "m2", offsetDays: 14 });

    const updated_m1 = { ...m1, dueDate: "2025-03-01" };
    const result = recalculateDates([updated_m1, m2, m3], ["m1"]);

    // m2 is funded → skipped; m3 uses m2's EXISTING date (2025-04-01) + 14
    expect(result.computedDates["m3"]).toBe("2025-04-15");
  });

  it("handles diamond dependency (shared upstream)", () => {
    // m1 → m2, m1 → m3, m2 → m4, m3 → m4
    const m1 = mkMilestone({ id: "m1", dueDate: "2025-01-01" });
    const m2 = mkMilestone({ id: "m2", dueDate: null, dependsOnId: "m1", offsetDays: 7 });
    const m3 = mkMilestone({ id: "m3", dueDate: null, dependsOnId: "m1", offsetDays: 14 });
    // m4 depends on m3 (the longer of the two paths)
    const m4 = mkMilestone({ id: "m4", dueDate: null, dependsOnId: "m3", offsetDays: 7 });

    const updated_m1 = { ...m1, dueDate: "2025-02-01" };
    const result = recalculateDates([updated_m1, m2, m3, m4], ["m1"]);

    expect(result.computedDates["m2"]).toBe("2025-02-08");
    expect(result.computedDates["m3"]).toBe("2025-02-15");
    expect(result.computedDates["m4"]).toBe("2025-02-22");
  });

  it("warns about milestones with no upstream due_date", () => {
    const m1 = mkMilestone({ id: "m1", dueDate: null }); // no date
    const m2 = mkMilestone({ id: "m2", dependsOnId: "m1", offsetDays: 7 });

    const result = recalculateDates([m1, m2], ["m1"]);
    expect(result.warnings.some((w) => w.includes("m2"))).toBe(true);
  });

  it("returns empty updates when no dependents exist", () => {
    const m1 = mkMilestone({ id: "m1", dueDate: "2025-01-01" });
    const result = recalculateDates([m1], ["m1"]);
    expect(result.updatedMilestones).toHaveLength(0);
  });

  it("seeds are not included in computedDates output", () => {
    const m1 = mkMilestone({ id: "m1", dueDate: "2025-01-01" });
    const result = recalculateDates([m1], ["m1"]);
    expect(result.computedDates["m1"]).toBeUndefined();
  });
});
