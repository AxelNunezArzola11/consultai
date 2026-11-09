/**
 * Security + functional regression tests for GET /api/projects/[id]/ledger.
 *
 * Security: unauthenticated / freelancer / role-header-forged callers get
 * 403, and Company B cannot read Company A's financial ledger (403
 * cross-company). Freelancers never see company financials.
 *
 * Functional (ledger visibility): the owning company sees one row per
 * milestone ordered by position, and a project with no milestones returns
 * an honest empty row set (not 404, not an error).
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as milestonesPOST } from "../milestones/route";
import { GET as ledgerGET } from "./route";
import { resetAuthStoreForTests } from "@/lib/auth/session";
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

async function createMilestone(cookie: string, projectId: string, title: string): Promise<string> {
  const res = await milestonesPOST(
    new NextRequest(`http://localhost:3000/api/projects/${projectId}/milestones`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ title, startDate: "2026-05-01", durationDays: 4, budgetUsd: 500 }),
    }),
    { params: Promise.resolve({ id: projectId }) }
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { milestone: { id: string } };
  return data.milestone.id;
}

function ledgerReq(projectId: string, init: { cookie?: string; roleHeader?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.roleHeader) headers["X-ConsultAI-Role"] = init.roleHeader;
  return new NextRequest(`http://localhost:3000/api/projects/${projectId}/ledger`, { headers });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

type LedgerRow = {
  id: string;
  title: string;
  status: string;
  budgetUsd: number;
  dueDate: string | null;
  position: number;
};

describe("GET /api/projects/[id]/ledger", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated caller → 403", async () => {
    const res = await ledgerGET(ledgerReq("ledger-proj-x"), params("ledger-proj-x"));
    expect(res.status).toBe(403);
  });

  it("freelancer cannot read company financials → 403", async () => {
    const cookiesA = await registerCompany("ledger-a@consultai.test", "Ledger Alpha");
    await createProject(cookiesA, "ledger-proj-alpha");
    const freeCookies = await registerFreelancer("ledger-free@consultai.test");

    const res = await ledgerGET(
      ledgerReq("ledger-proj-alpha", { cookie: freeCookies }),
      params("ledger-proj-alpha")
    );
    expect(res.status).toBe(403);
  });

  it("X-ConsultAI-Role header does not open the ledger", async () => {
    const res = await ledgerGET(
      ledgerReq("ledger-proj-x", { roleHeader: "admin" }),
      params("ledger-proj-x")
    );
    expect(res.status).toBe(403);
  });

  it("Company B cannot read Company A's ledger → 403", async () => {
    const cookiesA = await registerCompany("ledger-a2@consultai.test", "Ledger Alpha2");
    const cookiesB = await registerCompany("ledger-b@consultai.test", "Ledger Beta");
    await createProject(cookiesA, "ledger-proj-a2");

    const res = await ledgerGET(
      ledgerReq("ledger-proj-a2", { cookie: cookiesB }),
      params("ledger-proj-a2")
    );
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("forbidden");
  });

  it("owner sees one row per milestone, ordered by position", async () => {
    const cookiesA = await registerCompany("ledger-owner@consultai.test", "Ledger Owner");
    await createProject(cookiesA, "ledger-proj-owner");
    const first = await createMilestone(cookiesA, "ledger-proj-owner", "Ledger MS one");
    const second = await createMilestone(cookiesA, "ledger-proj-owner", "Ledger MS two");

    // Scramble store order to prove the API sorts by position, not insertion.
    const t = getDemoTables();
    const rowFirst = t.milestones.find((m) => m.id === first)!;
    const rowSecond = t.milestones.find((m) => m.id === second)!;
    const swap = rowFirst.position;
    rowFirst.position = rowSecond.position;
    rowSecond.position = swap;

    const res = await ledgerGET(
      ledgerReq("ledger-proj-owner", { cookie: cookiesA }),
      params("ledger-proj-owner")
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { rows: LedgerRow[] };
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0].position).toBeLessThanOrEqual(data.rows[1].position);
    expect(data.rows.map((r) => r.id).sort()).toEqual([first, second].sort());
    expect(data.rows[0]).toMatchObject({ status: "planned", budgetUsd: 500 });
  });

  it("project with no milestones returns an honest empty row set", async () => {
    const cookiesA = await registerCompany("ledger-empty@consultai.test", "Ledger Empty");
    await createProject(cookiesA, "ledger-proj-empty");

    const res = await ledgerGET(
      ledgerReq("ledger-proj-empty", { cookie: cookiesA }),
      params("ledger-proj-empty")
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { rows: LedgerRow[] };
    expect(data.rows).toEqual([]);
  });

  it("missing project → 404 for an authenticated company caller", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await ledgerGET(
      ledgerReq("ledger-proj-missing", { cookie: companyCookie }),
      params("ledger-proj-missing")
    );
    expect(res.status).toBe(404);
  });
});
