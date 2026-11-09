/**
 * Security + functional regression tests for POST /api/projects/[id]/milestones.
 *
 * Security: unauthenticated / freelancer / role-header-forged callers get 403
 * before any store access, and Company A cannot create milestones in
 * Company B's project (403 cross-company).
 *
 * Functional (drop persistence): a Bryntum backlog drop persists a milestone
 * row in the store and returns the server id + version so the client can
 * remap its optimistic temp id.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as milestonesPOST } from "./route";
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

function createReq(
  projectId: string,
  body: unknown,
  init: { cookie?: string; roleHeader?: string } = {}
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.roleHeader) headers["X-ConsultAI-Role"] = init.roleHeader;
  return new NextRequest(`http://localhost:3000/api/projects/${projectId}/milestones`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const DROP = { title: "Dropped backlog task", startDate: "2026-03-02", durationDays: 5, budgetUsd: 1200 };

describe("POST /api/projects/[id]/milestones", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated caller → 403 and nothing is persisted", async () => {
    const before = getDemoTables().milestones.length;
    const res = await milestonesPOST(createReq("demo-project-saas", DROP), params("demo-project-saas"));
    expect(res.status).toBe(403);
    expect(getDemoTables().milestones.length).toBe(before);
  });

  it("freelancer session → 403", async () => {
    const freeCookies = await registerFreelancer("ms-free@consultai.test");
    const res = await milestonesPOST(
      createReq("demo-project-saas", DROP, { cookie: freeCookies }),
      params("demo-project-saas")
    );
    expect(res.status).toBe(403);
  });

  it("X-ConsultAI-Role header does not escalate (no cookies, or freelancer cookies)", async () => {
    const forged = await milestonesPOST(
      createReq("demo-project-saas", DROP, { roleHeader: "admin" }),
      params("demo-project-saas")
    );
    expect(forged.status).toBe(403);

    const freeCookies = await registerFreelancer("ms-free-escalate@consultai.test");
    const escalated = await milestonesPOST(
      createReq("demo-project-saas", DROP, { cookie: freeCookies, roleHeader: "admin" }),
      params("demo-project-saas")
    );
    expect(escalated.status).toBe(403);
  });

  it("Company A cannot create milestones in Company B's project → 403", async () => {
    const cookiesA = await registerCompany("ms-a@consultai.test", "MS Alpha");
    const cookiesB = await registerCompany("ms-b@consultai.test", "MS Beta");
    await createProject(cookiesB, "ms-proj-beta-owned");

    const res = await milestonesPOST(
      createReq("ms-proj-beta-owned", DROP, { cookie: cookiesA }),
      params("ms-proj-beta-owned")
    );
    expect(res.status).toBe(403);
    expect(
      getDemoTables().milestones.filter((m) => m.projectId === "ms-proj-beta-owned")
    ).toHaveLength(0);
  });

  it("drop persistence: owner create persists a store row + returns server id/version for temp-id remap", async () => {
    const cookiesA = await registerCompany("ms-owner@consultai.test", "MS Owner");
    await createProject(cookiesA, "ms-proj-owner");

    const res = await milestonesPOST(
      createReq("ms-proj-owner", DROP, { cookie: cookiesA }),
      params("ms-proj-owner")
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      milestone: { id: string; projectId: string; title: string; version: number; position: number };
      simulated: boolean;
    };
    expect(data.ok).toBe(true);
    expect(data.simulated).toBe(true);
    expect(data.milestone.id.startsWith("ms-proj-owner_m")).toBe(true);
    expect(data.milestone.version).toBe(0);

    const row = getDemoTables().milestones.find((m) => m.id === data.milestone.id);
    expect(row?.title).toBe("Dropped backlog task");
    expect(row?.projectId).toBe("ms-proj-owner");
    expect(row?.budgetUsd).toBe("1200.00");
  });

  it("invalid body → 400; unknown project → 404", async () => {
    const cookiesA = await registerCompany("ms-valid@consultai.test", "MS Valid");
    await createProject(cookiesA, "ms-proj-valid");

    const bad = await milestonesPOST(
      createReq("ms-proj-valid", { title: "", startDate: "not-a-date" }, { cookie: cookiesA }),
      params("ms-proj-valid")
    );
    expect(bad.status).toBe(400);

    const missing = await milestonesPOST(
      createReq("ms-proj-missing", DROP, { cookie: cookiesA }),
      params("ms-proj-missing")
    );
    expect(missing.status).toBe(404);
  });
});
