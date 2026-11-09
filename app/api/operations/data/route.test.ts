/**
 * Security + functional regression tests for GET / PATCH /api/operations/data.
 *
 * Security: unauthenticated / freelancer callers get 403 on both verbs, and
 * Company A cannot edit Company B's tasks/consultants/projects (403
 * cross-company). Company sessions only see their own rows.
 *
 * Functional (enterprise grids data layer): projectId filtering narrows the
 * task grid, PATCH edits persist with a version bump and are visible on the
 * next GET (refresh), consultant edits validate rank (1-100) and status
 * enum, and financially locked (funded) tasks reject date/budget edits
 * with 409.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 *
 * NOTE: AG Grid client behaviors (column sort, quick-filter, CSV export via
 * the grid API) are browser-runtime only and are not unit-testable in the
 * node environment; server-side ordering is pinned by the ledger
 * position-sort test instead.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { GET as opsGET, PATCH as opsPATCH } from "./route";
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

function getReq(
  projectId: string | undefined,
  cookie?: string,
  tab?: string
): NextRequest {
  const params = new URLSearchParams();
  if (projectId != null) params.set("projectId", projectId);
  if (tab !== undefined) params.set("tab", tab);
  const qs = params.toString();
  const url = `http://localhost:3000/api/operations/data${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new NextRequest(url, { headers });
}

function patchReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost:3000/api/operations/data", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

type TaskRow = { id: string; projectId: string; title: string; dueDate: string; version: number };

describe("/api/operations/data", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated GET and PATCH → 403; freelancer GET and PATCH → 403", async () => {
    expect((await opsGET(getReq(undefined))).status).toBe(403);
    expect(
      (await opsPATCH(patchReq({ entity: "task", id: "x", updates: { title: "y" } }))).status
    ).toBe(403);

    const freeCookies = await registerFreelancer("ops-free@consultai.test");
    expect((await opsGET(getReq(undefined, freeCookies))).status).toBe(403);
    expect(
      (await opsPATCH(patchReq({ entity: "task", id: "x", updates: { title: "y" } }, freeCookies)))
        .status
    ).toBe(403);
  });

  it("Company A cannot edit Company B's task → 403 with no mutation", async () => {
    const cookiesA = await registerCompany("ops-a@consultai.test", "Ops Alpha");
    const cookiesB = await registerCompany("ops-b@consultai.test", "Ops Beta");
    const createRes = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookiesB },
        body: JSON.stringify({ projectId: "ops-proj-beta", title: "Ops Beta" }),
      })
    );
    expect(createRes.status).toBe(201);
    // Seed a B-owned task directly in the isolated store.
    getDemoTables().milestones.push({
      id: "ops-ms-beta-1",
      projectId: "ops-proj-beta",
      title: "Beta task",
      description: null,
      budgetUsd: "100.00",
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

    const res = await opsPATCH(
      patchReq({ entity: "task", id: "ops-ms-beta-1", updates: { title: "Hijacked" } }, cookiesA)
    );
    expect(res.status).toBe(403);
    expect(getDemoTables().milestones.find((m) => m.id === "ops-ms-beta-1")?.title).toBe("Beta task");
  });

  it("projectId filter narrows the task grid; unknown project yields no rows", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const filtered = await opsGET(getReq(DEMO_IDS.project, companyCookie));
    expect(filtered.status).toBe(200);
    const data = (await filtered.json()) as { tasks: TaskRow[] };
    expect(data.tasks.length).toBeGreaterThan(0);
    expect(data.tasks.every((t) => t.projectId === DEMO_IDS.project)).toBe(true);

    const empty = await opsGET(getReq("ops-proj-missing", companyCookie));
    expect(empty.status).toBe(200);
    const emptyData = (await empty.json()) as { tasks: TaskRow[] };
    expect(emptyData.tasks).toEqual([]);
  });

  it("task edit persists with version bump and is visible on refresh (GET)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const target = DEMO_IDS.milestones.qa; // planned: not financially locked
    const versionBefore = getDemoTables().milestones.find((m) => m.id === target)!.version;

    const edit = await opsPATCH(
      patchReq(
        { entity: "task", id: target, updates: { title: "QA renamed", dueDate: "2026-08-15" } },
        companyCookie
      )
    );
    expect(edit.status).toBe(200);
    const stored = getDemoTables().milestones.find((m) => m.id === target)!;
    expect(stored.title).toBe("QA renamed");
    expect(stored.dueDate).toBe("2026-08-15");
    expect(stored.version).toBe(versionBefore + 1);

    const refresh = await opsGET(getReq(DEMO_IDS.project, companyCookie));
    const refreshed = (await refresh.json()) as { tasks: TaskRow[] };
    const row = refreshed.tasks.find((t) => t.id === target)!;
    expect(row.title).toBe("QA renamed");
    expect(row.dueDate).toBe("2026-08-15");
  });

  it("consultant edit validates rank bounds + status enum, persists when valid", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const maya = DEMO_IDS.candidates.maya;

    const badRank = await opsPATCH(
      patchReq({ entity: "consultant", id: maya, updates: { rank: 101 } }, companyCookie)
    );
    expect(badRank.status).toBe(400);

    const badStatus = await opsPATCH(
      patchReq({ entity: "consultant", id: maya, updates: { status: "hired_everywhere" } }, companyCookie)
    );
    expect(badStatus.status).toBe(400);

    const ok = await opsPATCH(
      patchReq({ entity: "consultant", id: maya, updates: { rank: 7, status: "booked" } }, companyCookie)
    );
    expect(ok.status).toBe(200);
    const stored = getDemoTables().candidates.find((c) => c.id === maya)!;
    expect(stored.rank).toBe(7);
    expect(stored.status).toBe("booked");
  });

  it("funded task rejects date/budget edits → 409 (financial lock)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const fundedId = DEMO_IDS.milestones.frontend; // status funded in fixtures
    const res = await opsPATCH(
      patchReq({ entity: "task", id: fundedId, updates: { dueDate: "2026-09-01" } }, companyCookie)
    );
    expect(res.status).toBe(409);
  });
});

describe("/api/operations/data tab minimization", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  const ALL_GRIDS = [
    "consultants",
    "projects",
    "tasks",
    "companies",
    "contracts",
    "payments",
    "executions",
  ];

  it("unknown tab → 400 invalid_tab", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await opsGET(getReq(undefined, companyCookie, "bogus"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_tab");
  });

  it("session-authenticated company without tab → 400 tab_required (fail closed)", async () => {
    const cookiesA = await registerCompany("tab-a@consultai.test", "Tab Alpha");
    const res = await opsGET(getReq(undefined, cookiesA));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("tab_required");
  });

  it("live session-less company without tab → 403 (session required, D.3)", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevSecret = process.env.ROLE_COOKIE_SECRET;
    try {
      process.env.DEMO_MODE = "false";
      process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
      const liveCookie = (await signRoleCookie("company")).split(";")[0];
      const res = await opsGET(getReq(undefined, liveCookie));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("missing_company_context");
    } finally {
      process.env.DEMO_MODE = prevDemo;
      if (prevSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
      else process.env.ROLE_COOKIE_SECRET = prevSecret;
    }
  });

  it("live session-less company WITH tab → 403 (never unscoped rows)", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevSecret = process.env.ROLE_COOKIE_SECRET;
    try {
      process.env.DEMO_MODE = "false";
      process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
      const liveCookie = (await signRoleCookie("company")).split(";")[0];
      const res = await opsGET(getReq(undefined, liveCookie, "payments"));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("missing_company_context");
    } finally {
      process.env.DEMO_MODE = prevDemo;
      if (prevSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
      else process.env.ROLE_COOKIE_SECRET = prevSecret;
    }
  });

  it("live session-less company PATCH → 403 (no unscoped mutation)", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevSecret = process.env.ROLE_COOKIE_SECRET;
    try {
      process.env.DEMO_MODE = "false";
      process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
      const liveCookie = (await signRoleCookie("company")).split(";")[0];
      const res = await opsPATCH(
        patchReq({ entity: "task", id: "tab-ms-tab-proj-alpha", updates: { title: "hijack" } }, liveCookie)
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("missing_company_context");
    } finally {
      process.env.DEMO_MODE = prevDemo;
      if (prevSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
      else process.env.ROLE_COOKIE_SECRET = prevSecret;
    }
  });

  it("demo session-less company without tab keeps the full payload (demo parity)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await opsGET(getReq(undefined, companyCookie));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    for (const grid of ALL_GRIDS) {
      expect(data).toHaveProperty(grid);
    }
  });

  it("admin without tab keeps the full payload (back-compat)", async () => {
    const adminCookie = (await signRoleCookie("admin")).split(";")[0];
    const res = await opsGET(getReq(undefined, adminCookie));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    for (const grid of ALL_GRIDS) {
      expect(data).toHaveProperty(grid);
    }
    expect(data).toHaveProperty("disputesCount");
  });

  it("tab response carries only that grid; company scoping still applies", async () => {
    const cookiesA = await registerCompany("tab-a2@consultai.test", "Tab Alpha2");
    const cookiesB = await registerCompany("tab-b2@consultai.test", "Tab Beta2");
    for (const [cookie, proj] of [
      [cookiesA, "tab-proj-alpha"],
      [cookiesB, "tab-proj-beta"],
    ] as const) {
      const createRes = await projectsPOST(
        new NextRequest("http://localhost:3000/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ projectId: proj, title: proj }),
        })
      );
      expect(createRes.status).toBe(201);
      getDemoTables().milestones.push({
        id: `tab-ms-${proj}`,
        projectId: proj,
        title: `${proj} task`,
        description: null,
        budgetUsd: "100.00",
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
    }

    const res = await opsGET(getReq(undefined, cookiesA, "tasks"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown[]>;
    expect(Object.keys(data).sort()).toEqual(["tab", "tasks"]);
    const tasks = data.tasks as Array<{ id: string }>;
    expect(tasks.some((t) => t.id === "tab-ms-tab-proj-alpha")).toBe(true);
    expect(tasks.every((t) => t.id !== "tab-ms-tab-proj-beta")).toBe(true);
  });

  it("tasks tab strips PayPal ids; payments tab keeps them", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const tasksRes = await opsGET(
      getReq(DEMO_IDS.project, companyCookie, "tasks")
    );
    expect(tasksRes.status).toBe(200);
    const tasksData = (await tasksRes.json()) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(tasksData.tasks.length).toBeGreaterThan(0);
    for (const row of tasksData.tasks) {
      expect(row).not.toHaveProperty("paypalOrderId");
      expect(row).not.toHaveProperty("paypalPayoutBatchId");
    }

    const payRes = await opsGET(
      getReq(DEMO_IDS.project, companyCookie, "payments")
    );
    expect(payRes.status).toBe(200);
    const payData = (await payRes.json()) as {
      payments: Array<Record<string, unknown>>;
    };
    expect(payData.payments.length).toBeGreaterThan(0);
    expect(payData.payments[0]).toHaveProperty("paypalOrderId");
    expect(payData.payments[0]).toHaveProperty("grossUsd");
  });

  it("contracts tab drops candidateEmail and redacts documentHash", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await opsGET(
      getReq(DEMO_IDS.project, companyCookie, "contracts")
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      contracts: Array<Record<string, unknown>>;
    };
    expect(data.contracts.length).toBeGreaterThan(0);
    for (const row of data.contracts) {
      expect(row).not.toHaveProperty("candidateEmail");
      expect(row).toHaveProperty("candidateId");
      expect(row).toHaveProperty("candidateName");
      const hash = row.documentHash as string;
      expect(hash === "—" || hash.startsWith("sha256:…")).toBe(true);
      // The full stored hash never leaves the server on this tab.
      expect(JSON.stringify(row)).not.toContain("demo-hash-maya-nda");
      expect(JSON.stringify(row)).not.toContain("demo-hash-raj-nda");
    }
  });

  it("disputesCount is emitted only on the companies tab (and full payload)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const tasksRes = await opsGET(getReq(undefined, companyCookie, "tasks"));
    expect(tasksRes.status).toBe(200);
    expect(await tasksRes.json()).not.toHaveProperty("disputesCount");

    const coRes = await opsGET(getReq(undefined, companyCookie, "companies"));
    expect(coRes.status).toBe(200);
    expect(await coRes.json()).toHaveProperty("disputesCount");
  });
});
