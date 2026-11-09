/**
 * Engine-level scope enforcement tests for the AI-Ops orchestrator.
 *
 * Pins the two fail-closed rules that routes rely on:
 * - getAiOpsDashboardSnapshot: company scope filters EVERY section; a null
 *   (global) scope is admin-only.
 * - runSupervisorWorkflow: explicit projectId is always required (no
 *   global-project fallback) and company runs are verified against the
 *   scope before any read/write.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import {
  getAiOpsDashboardSnapshot,
  runSupervisorWorkflow,
  ScopedAccessError,
  MissingProjectError,
} from "./orchestrator-engine";
import { getSessionFromCookie, resetAuthStoreForTests } from "@/lib/auth/session";
import { getDemoTables, resetDemoStore } from "@/lib/demo/store";

function extractCookies(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies.map((c) => c.split(";")[0]).join("; ");
  }
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

async function registerCompany(email: string, companyName: string): Promise<string> {
  const res = await registerPOST(
    new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountType: "company",
        companyName,
        contactName: "Synthetic Owner",
        email,
        password: "SyntheticPass2026!",
        termsAccepted: true,
      }),
    })
  );
  expect(res.status).toBe(201);
  return extractCookies(res);
}

async function setupAB(): Promise<{
  cookiesA: string;
  companyA: string;
  companyB: string;
}> {
  const cookiesA = await registerCompany("scope-a@consultai.test", "Scope Alpha");
  const cookiesB = await registerCompany("scope-b@consultai.test", "Scope Beta");
  for (const [cookie, id] of [
    [cookiesA, "scope-proj-alpha"],
    [cookiesB, "scope-proj-beta"],
  ] as const) {
    const res = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ projectId: id, title: `Synthetic ${id}` }),
      })
    );
    expect(res.status).toBe(201);
  }
  const sessionA = await getSessionFromCookie(cookiesA);
  const sessionB = await getSessionFromCookie(cookiesB);
  return {
    cookiesA,
    companyA: sessionA!.companyId!,
    companyB: sessionB!.companyId!,
  };
}

describe("orchestrator-engine company scoping", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("snapshot with null scope + company role throws (global is admin-only)", async () => {
    await expect(
      getAiOpsDashboardSnapshot({
        scopeCompanyId: null,
        role: "company",
      })
    ).rejects.toBeInstanceOf(ScopedAccessError);
  });

  it("snapshot scoped to A excludes B projects and cross-scope projectIds throw", async () => {
    const { companyA } = await setupAB();
    const snap = await getAiOpsDashboardSnapshot({
      scopeCompanyId: companyA,
      role: "company",
    });
    expect(JSON.stringify(snap)).not.toContain("scope-proj-beta");
    await expect(
      getAiOpsDashboardSnapshot({
        projectId: "scope-proj-beta",
        scopeCompanyId: companyA,
        role: "company",
      })
    ).rejects.toBeInstanceOf(ScopedAccessError);
    const own = await getAiOpsDashboardSnapshot({
      projectId: "scope-proj-alpha",
      scopeCompanyId: companyA,
      role: "company",
    });
    expect(own).toBeDefined();
  });

  it("snapshot with null scope + admin role keeps the global view", async () => {
    await setupAB();
    const snap = await getAiOpsDashboardSnapshot({
      scopeCompanyId: null,
      role: "admin",
    });
    const serialized = JSON.stringify(snap);
    expect(serialized).toContain("scope-proj-alpha");
    expect(serialized).toContain("scope-proj-beta");
    expect(serialized).toContain("demo-project-saas");
  });

  it("workflow requires an explicit projectId (no global fallback), every role", async () => {
    const { companyA } = await setupAB();
    await expect(
      runSupervisorWorkflow({
        userRequest: "Run a consolidated project review",
        actorRole: "company",
        scopeCompanyId: companyA,
      })
    ).rejects.toBeInstanceOf(MissingProjectError);
    await expect(
      runSupervisorWorkflow({
        userRequest: "Run a consolidated project review",
        actorRole: "company",
        scopeCompanyId: companyA,
        projectId: "",
      })
    ).rejects.toBeInstanceOf(MissingProjectError);
    await expect(
      runSupervisorWorkflow({
        userRequest: "Run a consolidated project review",
        actorRole: "admin",
        scopeCompanyId: null,
      })
    ).rejects.toBeInstanceOf(MissingProjectError);
  });

  it("workflow rejects null scope for company role before any read/write", async () => {
    await setupAB();
    await expect(
      runSupervisorWorkflow({
        userRequest: "Run a consolidated project review",
        projectId: "scope-proj-alpha",
        actorRole: "company",
        scopeCompanyId: null,
      })
    ).rejects.toBeInstanceOf(ScopedAccessError);
    // No execution was recorded for the rejected run.
    expect(
      getDemoTables().agentExecutions.some((e) => e.projectId === "scope-proj-alpha")
    ).toBe(false);
  });

  it("workflow rejects cross-company projects; own + admin runs succeed", async () => {
    const { companyA, companyB } = await setupAB();
    await expect(
      runSupervisorWorkflow({
        userRequest: "Run a consolidated project review",
        projectId: "scope-proj-beta",
        actorRole: "company",
        scopeCompanyId: companyA,
      })
    ).rejects.toBeInstanceOf(ScopedAccessError);

    const own = await runSupervisorWorkflow({
      userRequest: "Run a consolidated project review",
      projectId: "scope-proj-alpha",
      actorRole: "company",
      scopeCompanyId: companyA,
    });
    expect(own.project_id).toBe("scope-proj-alpha");

    const admin = await runSupervisorWorkflow({
      userRequest: "Run a consolidated project review",
      projectId: "scope-proj-beta",
      actorRole: "admin",
      scopeCompanyId: null,
    });
    expect(admin.project_id).toBe("scope-proj-beta");
    expect(companyB).not.toBe(companyA);
  });
});
