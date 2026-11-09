/**
 * Functional regression tests for demo/live mode status + fixture isolation.
 *
 * - getSystemHealth in demo mode reports simulated/DEMO with every external
 *   probe skipped (no network, no database contact).
 * - Demo write-controls are never enabled in offline demo mode, even with
 *   ALLOW_DEMO_WRITES=true (they mutate a REAL database).
 * - resetDemoStore restores the canonical TechNova fixtures after any
 *   mutation, so synthetic test writes never leak across tests.
 *
 * In-memory only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSystemHealth } from "./health";
import {
  DEMO_IDS,
  areDemoWriteControlsEnabled,
  demoModeLabel,
  isDemoMode,
} from "./config";
import { getDemoTables, resetDemoStore } from "./store";

describe("demo status + fixture isolation", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    delete process.env.ALLOW_DEMO_WRITES;
    resetDemoStore();
  });

  afterEach(() => {
    process.env.DEMO_MODE = prevEnv.DEMO_MODE;
    if (prevEnv.ALLOW_DEMO_WRITES === undefined) delete process.env.ALLOW_DEMO_WRITES;
    else process.env.ALLOW_DEMO_WRITES = prevEnv.ALLOW_DEMO_WRITES;
    resetDemoStore();
  });

  it("demo health reports simulated with every external probe skipped", async () => {
    const started = Date.now();
    const health = await getSystemHealth();
    // No network probes run in demo mode: must resolve immediately.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(health.status).toBe("simulated");
    expect(health.mode).toBe("DEMO");
    expect(health.latencyMs).toBeNull();
    expect(health.checks).toEqual({
      database: "skipped_demo",
      paypal: "skipped_demo",
      ai: "skipped_demo",
      backend: "skipped_demo",
    });
    expect(health.detail).toContain("demo");
  });

  it("mode helpers agree: DEMO label in demo mode, LIVE otherwise", () => {
    expect(isDemoMode()).toBe(true);
    expect(demoModeLabel()).toBe("DEMO");
    process.env.DEMO_MODE = "false";
    expect(isDemoMode()).toBe(false);
    expect(demoModeLabel()).toBe("LIVE");
  });

  it("demo write-controls are never enabled in offline demo mode", () => {
    process.env.ALLOW_DEMO_WRITES = "true";
    expect(isDemoMode()).toBe(true);
    expect(areDemoWriteControlsEnabled()).toBe(false);

    process.env.DEMO_MODE = "false";
    expect(areDemoWriteControlsEnabled()).toBe(true);

    delete process.env.ALLOW_DEMO_WRITES;
    // NODE_ENV=test here (not development): controls stay off.
    expect(areDemoWriteControlsEnabled()).toBe(false);
  });

  it("canonical TechNova fixtures exist with six milestones", () => {
    const t = getDemoTables();
    const project = t.projects.find((p) => p.id === DEMO_IDS.project);
    expect(project?.title).toBe("Enterprise SaaS Implementation");
    expect(project?.companyId).toBe(DEMO_IDS.company);
    const milestones = t.milestones.filter((m) => m.projectId === DEMO_IDS.project);
    expect(milestones).toHaveLength(6);
    expect(new Set(milestones.map((m) => m.id))).toEqual(
      new Set(Object.values(DEMO_IDS.milestones))
    );
  });

  it("resetDemoStore restores fixtures after mutation (no cross-test leak)", () => {
    const t = getDemoTables();
    t.projects.push({
      id: "synthetic-leak-probe",
      companyId: DEMO_IDS.company,
      title: "Leak probe",
      rawBrief: null,
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
    t.milestones.find((m) => m.id === DEMO_IDS.milestones.qa)!.title = "Mutated";

    resetDemoStore();

    const fresh = getDemoTables();
    expect(fresh.projects.some((p) => p.id === "synthetic-leak-probe")).toBe(false);
    expect(fresh.milestones.find((m) => m.id === DEMO_IDS.milestones.qa)?.title).toBe(
      "Quality Assurance"
    );
  });
});
