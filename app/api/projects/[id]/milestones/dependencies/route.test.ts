/**
 * Security + functional regression tests for
 * POST / DELETE /api/projects/[id]/milestones/dependencies.
 *
 * Security: unauthenticated / freelancer callers get 403 before any store
 * access, and Company A cannot link/unlink milestones in Company B's
 * project (403 cross-company).
 *
 * Functional (dependency persistence): upsert persists dependsOnId +
 * offsetDays with a version bump, DELETE unlinks, and self-dependency /
 * cycles / funded children / version conflicts are rejected with 409.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 *
 * Canonical chain used (fresh per test via resetDemoStore):
 *   requirements(paid) <- frontend(funded), backend(verifying)
 *   backend <- integration(pending_approval) <- qa(planned) <- deploy(planned)
 * Only qa/deploy are non-funded, so link/unlink success paths use them.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as milestonesPOST } from "../route";
import { POST as depPOST, DELETE as depDELETE } from "./route";
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

function depReq(
  projectId: string,
  method: "POST" | "DELETE",
  body: unknown,
  cookie?: string
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`http://localhost:3000/api/projects/${projectId}/milestones/dependencies`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const M = DEMO_IDS.milestones;

describe("milestone dependencies API", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated POST and DELETE → 403 with no store mutation", async () => {
    const qaBefore = { ...getDemoTables().milestones.find((m) => m.id === M.qa)! };
    const postRes = await depPOST(
      depReq(DEMO_IDS.project, "POST", { milestoneId: M.qa, dependsOnId: M.backend }),
      params(DEMO_IDS.project)
    );
    expect(postRes.status).toBe(403);
    const delRes = await depDELETE(
      depReq(DEMO_IDS.project, "DELETE", { milestoneId: M.qa }),
      params(DEMO_IDS.project)
    );
    expect(delRes.status).toBe(403);
    expect(getDemoTables().milestones.find((m) => m.id === M.qa)).toEqual(qaBefore);
  });

  it("Company A cannot link or unlink milestones in Company B's project → 403", async () => {
    const cookiesA = await registerCompany("dep-a@consultai.test", "Dep Alpha");
    const cookiesB = await registerCompany("dep-b@consultai.test", "Dep Beta");
    const createRes = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookiesB },
        body: JSON.stringify({ projectId: "dep-proj-beta", title: "Dep Beta" }),
      })
    );
    expect(createRes.status).toBe(201);

    const link = await depPOST(
      depReq("dep-proj-beta", "POST", { milestoneId: "x", dependsOnId: "y" }, cookiesA),
      params("dep-proj-beta")
    );
    expect(link.status).toBe(403);
    const unlink = await depDELETE(
      depReq("dep-proj-beta", "DELETE", { milestoneId: "x" }, cookiesA),
      params("dep-proj-beta")
    );
    expect(unlink.status).toBe(403);
  });

  it("upsert persists dependsOnId + offsetDays and bumps the version", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await depPOST(
      depReq(
        DEMO_IDS.project,
        "POST",
        { milestoneId: M.deploy, dependsOnId: M.requirements, offsetDays: 2 },
        companyCookie
      ),
      params(DEMO_IDS.project)
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; version: number; simulated: boolean };
    expect(data.ok).toBe(true);
    expect(data.simulated).toBe(true);

    const row = getDemoTables().milestones.find((m) => m.id === M.deploy)!;
    expect(row.dependsOnId).toBe(M.requirements);
    expect(row.offsetDays).toBe(2);
    expect(row.version).toBe(data.version);
  });

  it("DELETE unlinks (dependsOnId/offsetDays cleared) and bumps the version", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    expect(getDemoTables().milestones.find((m) => m.id === M.qa)?.dependsOnId).toBe(M.integration);

    const res = await depDELETE(
      depReq(DEMO_IDS.project, "DELETE", { milestoneId: M.qa }, companyCookie),
      params(DEMO_IDS.project)
    );
    expect(res.status).toBe(200);
    const row = getDemoTables().milestones.find((m) => m.id === M.qa)!;
    expect(row.dependsOnId).toBeNull();
    expect(row.offsetDays).toBeNull();
    expect(row.version).toBe(1);
  });

  it("self-dependency, cycles, funded children, and version conflicts → 409", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];

    const self = await depPOST(
      depReq(DEMO_IDS.project, "POST", { milestoneId: M.qa, dependsOnId: M.qa }, companyCookie),
      params(DEMO_IDS.project)
    );
    expect(self.status).toBe(409);

    // deploy already depends on qa, so qa -> deploy closes a 2-cycle.
    const cycle = await depPOST(
      depReq(DEMO_IDS.project, "POST", { milestoneId: M.qa, dependsOnId: M.deploy }, companyCookie),
      params(DEMO_IDS.project)
    );
    expect(cycle.status).toBe(409);

    // frontend is funded: links are financially locked.
    const funded = await depPOST(
      depReq(DEMO_IDS.project, "POST", { milestoneId: M.frontend, dependsOnId: M.qa }, companyCookie),
      params(DEMO_IDS.project)
    );
    expect(funded.status).toBe(409);

    const conflict = await depPOST(
      depReq(
        DEMO_IDS.project,
        "POST",
        { milestoneId: M.deploy, dependsOnId: M.requirements, expectedVersion: 999 },
        companyCookie
      ),
      params(DEMO_IDS.project)
    );
    expect(conflict.status).toBe(409);
  });

  it("dependency round-trip on a synthetic project: create → link → unlink", async () => {
    const cookies = await registerCompany("dep-roundtrip@consultai.test", "Dep RT");
    const createRes = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookies },
        body: JSON.stringify({ projectId: "dep-proj-rt", title: "Dep RT" }),
      })
    );
    expect(createRes.status).toBe(201);

    const ids: string[] = [];
    for (const title of ["RT first", "RT second"]) {
      const msRes = await milestonesPOST(
        new NextRequest("http://localhost:3000/api/projects/dep-proj-rt/milestones", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookies },
          body: JSON.stringify({ title, startDate: "2026-04-01", durationDays: 3 }),
        }),
        params("dep-proj-rt")
      );
      expect(msRes.status).toBe(200);
      const msData = (await msRes.json()) as { milestone: { id: string } };
      ids.push(msData.milestone.id);
    }

    const link = await depPOST(
      depReq("dep-proj-rt", "POST", { milestoneId: ids[1], dependsOnId: ids[0] }, cookies),
      params("dep-proj-rt")
    );
    expect(link.status).toBe(200);
    expect(getDemoTables().milestones.find((m) => m.id === ids[1])?.dependsOnId).toBe(ids[0]);

    const unlink = await depDELETE(
      depReq("dep-proj-rt", "DELETE", { milestoneId: ids[1] }, cookies),
      params("dep-proj-rt")
    );
    expect(unlink.status).toBe(200);
    expect(getDemoTables().milestones.find((m) => m.id === ids[1])?.dependsOnId).toBeNull();
  });
});
