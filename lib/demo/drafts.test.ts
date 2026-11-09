/**
 * Demo draft resolution for the planner (lib/demo/drafts).
 *
 * Vercel serverless runs every request on a potentially different instance,
 * and the demo store is per-instance memory. A draft created by POST
 * /api/projects on instance A is therefore missing when the planner GET
 * lands on instance B. resolveDemoDraftForPlanning closes that gap: on a
 * demo-store miss it rehydrates the POST-accepted draft from the navigation
 * params (id + title + brief) instead of reporting "not found".
 *
 * Safety properties pinned here:
 * - Existing rows are returned untouched (rehydration never overwrites).
 * - Bare/invalid IDs without creation params still miss (the not-found
 *   screen stays a legitimate state for invalid links).
 * - The owning company is caller-supplied (server-derived from the session),
 *   never taken from the URL — no spoofing.
 * - Validation mirrors POST /api/projects (id required, max 64 chars;
 *   title trimmed, max 200 chars; brief max 20000 chars).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getDemoTables, resetDemoStore } from "./store";
import { resolveDemoDraftForPlanning } from "./drafts";

const COMPANY = "company-rehydrate-1";

describe("resolveDemoDraftForPlanning", () => {
  beforeEach(() => {
    resetDemoStore();
  });

  it("miss without creation params stays a miss (not-found preserved)", () => {
    expect(
      resolveDemoDraftForPlanning({
        projectId: "no-such-draft",
        companyId: COMPANY,
      })
    ).toBeUndefined();
    expect(
      getDemoTables().projects.some((p) => p.id === "no-such-draft")
    ).toBe(false);
  });

  it("blank title does not rehydrate", () => {
    expect(
      resolveDemoDraftForPlanning({
        projectId: "blank-title-draft",
        title: "   ",
        companyId: COMPANY,
      })
    ).toBeUndefined();
    expect(
      getDemoTables().projects.some((p) => p.id === "blank-title-draft")
    ).toBe(false);
  });

  it("miss with params rehydrates the accepted draft (exact id/title/brief)", () => {
    const draft = resolveDemoDraftForPlanning({
      projectId: "rehydrated-1",
      title: "Rehydrated Project",
      brief: "Kickoff brief",
      companyId: COMPANY,
    });
    expect(draft).toMatchObject({
      id: "rehydrated-1",
      title: "Rehydrated Project",
      rawBrief: "Kickoff brief",
      companyId: COMPANY,
    });
    const stored = getDemoTables().projects.find(
      (p) => p.id === "rehydrated-1"
    )!;
    expect(stored.title).toBe("Rehydrated Project");
    expect(stored.status).toBe("draft");
    // Second resolution hits the stored row (no duplicate).
    resolveDemoDraftForPlanning({
      projectId: "rehydrated-1",
      title: "Rehydrated Project",
      companyId: COMPANY,
    });
    expect(
      getDemoTables().projects.filter((p) => p.id === "rehydrated-1")
    ).toHaveLength(1);
  });

  it("existing rows are returned untouched (no overwrite)", () => {
    const first = resolveDemoDraftForPlanning({
      projectId: "keep-original",
      title: "Original",
      brief: "v1",
      companyId: COMPANY,
    })!;
    expect(first.rawBrief).toBe("v1");
    const second = resolveDemoDraftForPlanning({
      projectId: "keep-original",
      title: "Sneaky Rename",
      brief: "v2",
      companyId: "company-other",
    })!;
    expect(second.companyId).toBe(COMPANY);
    expect(second.title).toBe("Original");
    expect(second.rawBrief).toBe("v1");
    expect(
      getDemoTables().projects.find((p) => p.id === "keep-original")?.title
    ).toBe("Original");
  });

  it("invalid project ids never rehydrate, even with a title", () => {
    for (const projectId of ["", "   ", "x".repeat(65)]) {
      expect(
        resolveDemoDraftForPlanning({
          projectId,
          title: "Has Title",
          companyId: COMPANY,
        })
      ).toBeUndefined();
    }
    expect(
      getDemoTables().projects.some((p) => p.title === "Has Title")
    ).toBe(false);
  });

  it("title mirrors POST normalization (trim + 200-char cap)", () => {
    const draft = resolveDemoDraftForPlanning({
      projectId: "title-norm",
      title: "  " + "t".repeat(300) + "  ",
      companyId: COMPANY,
    })!;
    expect(
      getDemoTables().projects.find((p) => p.id === "title-norm")?.title
    ).toBe("t".repeat(200));
    expect(draft.id).toBe("title-norm");
  });

  it("cross-instance round-trip: created, store reset, resolved again", () => {
    // Instance A: POST-equivalent insert.
    getDemoTables().projects.push({
      id: "x-instance-roundtrip",
      companyId: COMPANY,
      title: "Roundtrip",
      rawBrief: "brief",
      structuredBrief: null,
      structuredPlan: null,
      sanitizedSummary: null,
      githubRepoUrl: null,
      acceptanceCriteria: null,
      status: "draft",
      autoApproveThresholdUsd: "500.00",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Instance B: fresh store (Vercel routed the planner GET elsewhere).
    resetDemoStore();
    expect(
      getDemoTables().projects.find((p) => p.id === "x-instance-roundtrip")
    ).toBeUndefined();
    // Planner rehydrates from the navigation params it was given at creation.
    const draft = resolveDemoDraftForPlanning({
      projectId: "x-instance-roundtrip",
      title: "Roundtrip",
      brief: "brief",
      companyId: COMPANY,
    });
    expect(draft).toMatchObject({
      id: "x-instance-roundtrip",
      rawBrief: "brief",
      companyId: COMPANY,
    });
  });
});
