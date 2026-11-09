/**
 * Company-isolation regression tests for POST /api/ai/planning.
 *
 * Reschedule/plan messages run the supervisor workflow, so they require an
 * explicit projectId owned by the caller's company scope. Plain chat never
 * touches project data and keeps the role gate only.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as planningPOST } from "./route";
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

function planReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost:3000/api/ai/planning", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/planning company isolation", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated caller → 403", async () => {
    const res = await planningPOST(planReq({ message: "delay frontend by 3 days" }));
    expect(res.status).toBe(403);
  });

  it("reschedule message without projectId → 400 missing_project_id", async () => {
    const cookiesA = await registerCompany("plan-a@consultai.test", "Plan Alpha");
    const res = await planningPOST(
      planReq({ message: "delay frontend by 3 days" }, cookiesA)
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("missing_project_id");
  });

  it("Company A reschedule against Company B's project → 403, no execution recorded", async () => {
    const cookiesA = await registerCompany("plan-a2@consultai.test", "Plan Alpha2");
    const cookiesB = await registerCompany("plan-b2@consultai.test", "Plan Beta2");
    await createProject(cookiesA, "plan-proj-alpha");
    await createProject(cookiesB, "plan-proj-beta");
    const before = getDemoTables().agentExecutions.length;

    const res = await planningPOST(
      planReq(
        { message: "delay frontend by 3 days", projectId: "plan-proj-beta" },
        cookiesA
      )
    );
    expect(res.status).toBe(403);
    expect(getDemoTables().agentExecutions.length).toBe(before);
  });

  it("Company A reschedule against its own project → 200 simulated proposal", async () => {
    const cookiesA = await registerCompany("plan-a3@consultai.test", "Plan Alpha3");
    await createProject(cookiesA, "plan-proj-alpha3");

    const res = await planningPOST(
      planReq(
        { message: "delay frontend by 3 days", projectId: "plan-proj-alpha3" },
        cookiesA
      )
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { executionId?: string; text?: string };
    expect(data.executionId).toBeDefined();
    expect(data.text).toContain("Multi-Agent Scheduling Proposal Generated");
  });

  it("plain chat without projectId is not project-gated (demo → honest 503)", async () => {
    const cookiesA = await registerCompany("plan-a4@consultai.test", "Plan Alpha4");
    const res = await planningPOST(
      planReq({ message: "hello, what can you do?" }, cookiesA)
    );
    // Plain chat never runs the workflow: no missing_project_id gate, just
    // the honest offline-demo unavailability for live AI chat.
    expect(res.status).toBe(503);
  });

  it("live session-less reschedule → 403; demo session-less reschedules TechNova", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevSecret = process.env.ROLE_COOKIE_SECRET;
    try {
      process.env.DEMO_MODE = "false";
      process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
      const liveCookie = (await signRoleCookie("company")).split(";")[0];
      const liveRes = await planningPOST(
        planReq(
          { message: "delay frontend by 3 days", projectId: DEMO_IDS.project },
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
    const demoRes = await planningPOST(
      planReq(
        { message: "delay frontend by 3 days", projectId: DEMO_IDS.project },
        demoCookie
      )
    );
    expect(demoRes.status).toBe(200);
  });
});
