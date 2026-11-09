/**
 * Security regression tests for POST /api/agent/brief.
 *
 * The brief agent streams LLM plans and resolves project ownership. These
 * tests pin the gate: unauthenticated / freelancer / role-header-forged
 * callers get 403 before any validation, LLM, or store access, and
 * Company A cannot start a brief session on Company B's project.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no LLM network calls, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as briefPOST } from "./route";
import { resetAuthStoreForTests } from "@/lib/auth/session";
import { DEMO_IDS } from "@/lib/demo/config";
import { resetDemoStore } from "@/lib/demo/store";

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

async function registerFreelancer(email: string): Promise<string> {
  const res = await registerPOST(
    new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountType: "freelancer",
        fullName: "Synthetic Dev",
        email,
        specialty: "Backend Engineer",
        password: "SyntheticPass2026!",
        termsAccepted: true,
      }),
    })
  );
  expect(res.status).toBe(201);
  return extractCookies(res);
}

function briefReq(body: unknown, init: { cookie?: string; roleHeader?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.roleHeader) headers["X-ConsultAI-Role"] = init.roleHeader;
  return new NextRequest("http://localhost:3000/api/agent/brief", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  projectId: DEMO_IDS.project,
  agentSessionId: "brief_sess_synthetic7",
  messages: [],
};

describe("POST /api/agent/brief auth gate", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated caller cannot create a brief → 403", async () => {
    const res = await briefPOST(briefReq(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it("freelancer session → 403", async () => {
    const freeCookies = await registerFreelancer("brief-free@consultai.test");
    const res = await briefPOST(briefReq(VALID_BODY, { cookie: freeCookies }));
    expect(res.status).toBe(403);
  });

  it("X-ConsultAI-Role header does not escalate to a brief session", async () => {
    const forged = await briefPOST(briefReq(VALID_BODY, { roleHeader: "admin" }));
    expect(forged.status).toBe(403);

    const freeCookies = await registerFreelancer("brief-free-escalate@consultai.test");
    const escalated = await briefPOST(
      briefReq(VALID_BODY, { cookie: freeCookies, roleHeader: "company" })
    );
    expect(escalated.status).toBe(403);
  });

  it("Company A cannot brief on Company B's project → 403 (no LLM invoked)", async () => {
    const cookiesA = await registerCompany("brief-a@consultai.test", "Brief Alpha");
    const cookiesB = await registerCompany("brief-b@consultai.test", "Brief Beta");
    const createRes = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookiesB },
        body: JSON.stringify({ projectId: "brief-proj-beta", title: "Brief Beta" }),
      })
    );
    expect(createRes.status).toBe(201);

    const res = await briefPOST(
      briefReq({ ...VALID_BODY, projectId: "brief-proj-beta" }, { cookie: cookiesA })
    );
    expect(res.status).toBe(403);
  });

  it("company role holder gets the deterministic simulated stream (honest demo, no LLM)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await briefPOST(briefReq(VALID_BODY, { cookie: companyCookie }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("SIMULATED PLANNING RUN");
    expect(text).toContain("Enterprise SaaS Implementation");
  });
});

describe("POST /api/agent/brief demo rehydration (serverless-safe)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("demo miss without creation title → 404 preserved", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await briefPOST(
      briefReq(
        { ...VALID_BODY, projectId: "brief-ghost-no-title" },
        { cookie: companyCookie }
      )
    );
    expect(res.status).toBe(404);
  });

  it("demo miss with creation title → 200 simulated stream (rehydrated)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await briefPOST(
      briefReq(
        {
          ...VALID_BODY,
          projectId: "brief-rehydrated-1",
          projectTitle: "Rehydrated Chat Project",
        },
        { cookie: companyCookie }
      )
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("SIMULATED PLANNING RUN");
    // The simulated plan text is fixture-fixed, but the store row must carry
    // the rehydrated creation title for downstream planner calls.
    const { getDemoTables } = await import("@/lib/demo/store");
    expect(
      getDemoTables().projects.find((p) => p.id === "brief-rehydrated-1")?.title
    ).toBe("Rehydrated Chat Project");
  });

  it("cross-instance: created, store reset, brief with title still streams", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const createRes = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: companyCookie },
        body: JSON.stringify({
          projectId: "brief-x-instance",
          title: "Cross Instance Chat",
        }),
      })
    );
    expect(createRes.status).toBe(201);
    // Fresh serverless instance: the store never saw the POST.
    resetDemoStore();
    const res = await briefPOST(
      briefReq(
        {
          ...VALID_BODY,
          projectId: "brief-x-instance",
          projectTitle: "Cross Instance Chat",
        },
        { cookie: companyCookie }
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SIMULATED PLANNING RUN");
    const { getDemoTables } = await import("@/lib/demo/store");
    expect(
      getDemoTables().projects.find((p) => p.id === "brief-x-instance")?.title
    ).toBe("Cross Instance Chat");
  });
});
