/**
 * Company-isolation regression tests for POST /api/ai-ops/execute.
 *
 * Every supervisor run requires an explicit projectId owned by the caller's
 * company scope (no global-project fallback), and supplied milestone /
 * candidate ids must belong to that project. Cross-company runs are
 * rejected before any workflow executes.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as executePOST } from "./route";
import { resetAuthStoreForTests } from "@/lib/auth/session";
import { DEMO_IDS } from "@/lib/demo/config";
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

async function createProject(cookie: string, projectId: string): Promise<void> {
  const res = await projectsPOST(
    new NextRequest("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ projectId, title: `Synthetic ${projectId}` }),
    })
  );
  expect(res.status).toBe(201);
}

function execReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost:3000/api/ai-ops/execute", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai-ops/execute company isolation", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated caller → 403", async () => {
    const res = await executePOST(
      execReq({ user_request: "Run a consolidated project review" })
    );
    expect(res.status).toBe(403);
  });

  it("company session without projectId → 400 missing_project_id (no global run)", async () => {
    const cookiesA = await registerCompany("exec-a@consultai.test", "Exec Alpha");
    const res = await executePOST(
      execReq({ user_request: "Run a consolidated project review" }, cookiesA)
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("missing_project_id");
  });

  it("Company A run against Company B's project → 403 with no execution recorded", async () => {
    const cookiesA = await registerCompany("exec-a2@consultai.test", "Exec Alpha2");
    const cookiesB = await registerCompany("exec-b2@consultai.test", "Exec Beta2");
    await createProject(cookiesA, "exec-proj-alpha");
    await createProject(cookiesB, "exec-proj-beta");
    const before = getDemoTables().agentExecutions.length;

    const res = await executePOST(
      execReq(
        {
          user_request: "Run a consolidated project review",
          project_id: "exec-proj-beta",
        },
        cookiesA
      )
    );
    expect(res.status).toBe(403);
    expect(getDemoTables().agentExecutions.length).toBe(before);
  });

  it("Company A run against its own project → 200 simulated execution", async () => {
    const cookiesA = await registerCompany("exec-a3@consultai.test", "Exec Alpha3");
    await createProject(cookiesA, "exec-proj-alpha3");

    const res = await executePOST(
      execReq(
        {
          user_request: "Run a consolidated project review",
          project_id: "exec-proj-alpha3",
        },
        cookiesA
      )
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { execution_id: string; project_id: string };
    expect(data.project_id).toBe("exec-proj-alpha3");
    expect(
      getDemoTables().agentExecutions.some((e) => e.id === data.execution_id)
    ).toBe(true);
  });

  it("milestone from another project → 403 (cross-project id confusion rejected)", async () => {
    const cookiesA = await registerCompany("exec-a4@consultai.test", "Exec Alpha4");
    const cookiesB = await registerCompany("exec-b4@consultai.test", "Exec Beta4");
    await createProject(cookiesA, "exec-proj-alpha4");
    await createProject(cookiesB, "exec-proj-beta4");
    getDemoTables().milestones.push({
      id: "exec-ms-beta4",
      projectId: "exec-proj-beta4",
      title: "Beta milestone",
      description: null,
      budgetUsd: "50.00",
      dueDate: "2026-07-01",
      status: "planned",
      dependsOnId: null,
      offsetDays: null,
      startDate: "2026-06-01",
      version: 0,
      paypalOrderId: null,
      paypalCaptureId: null,
      captureGrossUsd: null,
      captureFeeUsd: null,
      captureNetUsd: null,
      currency: null,
      paypalPayoutBatchId: null,
      paypalPayoutItemId: null,
      idempotencyKey: null,
      position: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await executePOST(
      execReq(
        {
          user_request: "Verify the deliverable",
          project_id: "exec-proj-alpha4",
          milestone_id: "exec-ms-beta4",
        },
        cookiesA
      )
    );
    expect(res.status).toBe(403);
  });

  it("live session-less company holder → 403; demo session-less runs TechNova fixtures", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevSecret = process.env.ROLE_COOKIE_SECRET;
    try {
      process.env.DEMO_MODE = "false";
      process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
      const liveCookie = (await signRoleCookie("company")).split(";")[0];
      const liveRes = await executePOST(
        execReq(
          {
            user_request: "Run a consolidated project review",
            project_id: DEMO_IDS.project,
          },
          liveCookie
        )
      );
      expect(liveRes.status).toBe(403);
    } finally {
      process.env.DEMO_MODE = prevDemo;
      if (prevSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
      else process.env.ROLE_COOKIE_SECRET = prevSecret;
    }

    const demoCookie = (await signRoleCookie("company")).split(";")[0];
    const demoRes = await executePOST(
      execReq(
        {
          user_request: "Run a consolidated project review",
          project_id: DEMO_IDS.project,
        },
        demoCookie
      )
    );
    expect(demoRes.status).toBe(200);
  });
});
