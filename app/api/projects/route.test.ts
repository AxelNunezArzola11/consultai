/**
 * Company-ownership regression tests for GET / POST /api/projects.
 *
 * POST: no silent company default — company role creates under its verified
 * session company (live session-less holders are rejected), admin creates
 * only under an explicit, existing body companyId. Idempotent replays are
 * ownership-checked unconditionally for company role.
 *
 * GET: company role lists its own company only; session-less holders are
 * rejected (never the full list). Admin keeps the explicit global list.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { GET as projectsGET, POST as projectsPOST } from "./route";
import { getSessionFromCookie, resetAuthStoreForTests } from "@/lib/auth/session";
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

function postReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost:3000/api/projects", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function getReq(cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost:3000/api/projects", { headers });
}

type ProjectRow = { id: string; companyId: string };

describe("POST /api/projects company ownership", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated POST → 403", async () => {
    const res = await projectsPOST(postReq({ projectId: "p1", title: "x" }));
    expect(res.status).toBe(403);
  });

  it("live session-less company POST → 403 missing_company_context (no default)", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevSecret = process.env.ROLE_COOKIE_SECRET;
    try {
      process.env.DEMO_MODE = "false";
      process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
      const liveCookie = (await signRoleCookie("company")).split(";")[0];
      const res = await projectsPOST(
        postReq({ projectId: "live-no-default", title: "x" }, liveCookie)
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "missing_company_context"
      );
    } finally {
      process.env.DEMO_MODE = prevDemo;
      if (prevSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
      else process.env.ROLE_COOKIE_SECRET = prevSecret;
    }
  });

  it("Company A creates → owned by A, never implicit company-1", async () => {
    const cookiesA = await registerCompany("proj-a@consultai.test", "Proj Alpha");
    const sessionA = await getSessionFromCookie(cookiesA);
    expect(sessionA?.companyId).toBeTruthy();

    const res = await projectsPOST(
      postReq({ projectId: "proj-alpha-owned", title: "Alpha owned" }, cookiesA)
    );
    expect(res.status).toBe(201);
    const stored = getDemoTables().projects.find((p) => p.id === "proj-alpha-owned")!;
    expect(stored.companyId).toBe(sessionA!.companyId);
    expect(stored.companyId).not.toBe("company-1");
  });

  it("client-supplied companyId is ignored for company role (no spoofing)", async () => {
    const cookiesA = await registerCompany("proj-a2@consultai.test", "Proj Alpha2");
    const cookiesB = await registerCompany("proj-b2@consultai.test", "Proj Beta2");
    const sessionA = await getSessionFromCookie(cookiesA);
    const sessionB = await getSessionFromCookie(cookiesB);

    const res = await projectsPOST(
      postReq(
        {
          projectId: "proj-spoof-attempt",
          title: "Spoof",
          companyId: sessionB!.companyId,
        },
        cookiesA
      )
    );
    expect(res.status).toBe(201);
    const stored = getDemoTables().projects.find((p) => p.id === "proj-spoof-attempt")!;
    expect(stored.companyId).toBe(sessionA!.companyId);
    expect(stored.companyId).not.toBe(sessionB!.companyId);
  });

  it("cross-company idempotent replay → 403; own replay → 200 created:false", async () => {
    const cookiesA = await registerCompany("proj-a3@consultai.test", "Proj Alpha3");
    const cookiesB = await registerCompany("proj-b3@consultai.test", "Proj Beta3");
    const first = await projectsPOST(
      postReq({ projectId: "proj-replay", title: "Replay" }, cookiesB)
    );
    expect(first.status).toBe(201);

    const cross = await projectsPOST(
      postReq({ projectId: "proj-replay", title: "Hijack" }, cookiesA)
    );
    expect(cross.status).toBe(403);

    const own = await projectsPOST(
      postReq({ projectId: "proj-replay", title: "Replay" }, cookiesB)
    );
    expect(own.status).toBe(200);
    expect(((await own.json()) as { created: boolean }).created).toBe(false);
  });

  it("POST echoes the canonical persisted project ID (create + replay)", async () => {
    const cookiesA = await registerCompany("proj-canon@consultai.test", "Proj Canon");
    const created = await projectsPOST(
      postReq({ projectId: "proj-canonical", title: "Canon" }, cookiesA)
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      projectId: "proj-canonical",
      created: true,
    });
    // The echoed ID is the stored row the planner must open.
    expect(
      getDemoTables().projects.find((p) => p.id === "proj-canonical")?.title
    ).toBe("Canon");

    const replay = await projectsPOST(
      postReq({ projectId: "proj-canonical", title: "Canon" }, cookiesA)
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      projectId: "proj-canonical",
      created: false,
    });
  });

  it("admin requires an explicit, existing body companyId (400/404, no default)", async () => {
    const adminCookie = (await signRoleCookie("admin")).split(";")[0];

    const missing = await projectsPOST(
      postReq({ projectId: "proj-admin-missing", title: "x" }, adminCookie)
    );
    expect(missing.status).toBe(400);

    const unknown = await projectsPOST(
      postReq(
        { projectId: "proj-admin-unknown", title: "x", companyId: "no-such-company" },
        adminCookie
      )
    );
    expect(unknown.status).toBe(404);

    const ok = await projectsPOST(
      postReq(
        {
          projectId: "proj-admin-ok",
          title: "Admin created",
          companyId: DEMO_IDS.company,
        },
        adminCookie
      )
    );
    expect(ok.status).toBe(201);
    expect(
      getDemoTables().projects.find((p) => p.id === "proj-admin-ok")?.companyId
    ).toBe(DEMO_IDS.company);
  });

  it("demo session-less company POST keeps working on fictional fixtures (demo parity)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const first = await projectsPOST(
      postReq({ projectId: "proj-demo-switcher", title: "Switcher" }, companyCookie)
    );
    expect(first.status).toBe(201);
    const stored = getDemoTables().projects.find((p) => p.id === "proj-demo-switcher")!;
    expect(stored.companyId).toBe(DEMO_IDS.company);
    expect(stored.companyId).not.toBe("company-1");

    const replay = await projectsPOST(
      postReq({ projectId: "proj-demo-switcher", title: "Switcher" }, companyCookie)
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { created: boolean }).created).toBe(false);
  });
});

describe("GET /api/projects own-company-only", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated GET → 403", async () => {
    expect((await projectsGET(getReq())).status).toBe(403);
  });

  it("session-less company GET → 403 (never the full list)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await projectsGET(getReq(companyCookie));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_company_context"
    );
  });

  it("Company A lists only its own projects", async () => {
    const cookiesA = await registerCompany("projga-a@consultai.test", "ProjG Alpha");
    const cookiesB = await registerCompany("projga-b@consultai.test", "ProjG Beta");
    expect(
      (
        await projectsPOST(
          postReq({ projectId: "projga-alpha", title: "A" }, cookiesA)
        )
      ).status
    ).toBe(201);
    expect(
      (
        await projectsPOST(
          postReq({ projectId: "projga-beta", title: "B" }, cookiesB)
        )
      ).status
    ).toBe(201);

    const resA = await projectsGET(getReq(cookiesA));
    expect(resA.status).toBe(200);
    const listA = ((await resA.json()) as { projects: ProjectRow[] }).projects;
    expect(listA.some((p) => p.id === "projga-alpha")).toBe(true);
    expect(listA.every((p) => p.id !== "projga-beta")).toBe(true);
    expect(listA.every((p) => p.id !== DEMO_IDS.project)).toBe(true);

    const resB = await projectsGET(getReq(cookiesB));
    expect(resB.status).toBe(200);
    const listB = ((await resB.json()) as { projects: ProjectRow[] }).projects;
    expect(listB.some((p) => p.id === "projga-beta")).toBe(true);
    expect(listB.every((p) => p.id !== "projga-alpha")).toBe(true);
  });

  it("admin GET keeps the explicit global list", async () => {
    const cookiesA = await registerCompany("projga-a2@consultai.test", "ProjG Alpha2");
    expect(
      (
        await projectsPOST(
          postReq({ projectId: "projga-alpha2", title: "A2" }, cookiesA)
        )
      ).status
    ).toBe(201);
    const adminCookie = (await signRoleCookie("admin")).split(";")[0];
    const res = await projectsGET(getReq(adminCookie));
    expect(res.status).toBe(200);
    const list = ((await res.json()) as { projects: ProjectRow[] }).projects;
    expect(list.some((p) => p.id === "projga-alpha2")).toBe(true);
    expect(list.some((p) => p.id === DEMO_IDS.project)).toBe(true);
  });
});
