/**
 * Security + functional regression tests for
 * PATCH / DELETE /api/projects/[id].
 *
 * Security: unauthenticated / freelancer callers get 403, and Company A
 * cannot patch or delete Company B's project (403 cross-company).
 *
 * Functional: owner PATCH persists mutable fields (githubRepoUrl) with URL
 * validation, owner DELETE cascades to child rows, and the canonical
 * TechNova demo project is protected from deletion (409).
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as milestonesPOST } from "./milestones/route";
import { PATCH as projectPATCH, DELETE as projectDELETE } from "./route";
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

function patchReq(projectId: string, body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`http://localhost:3000/api/projects/${projectId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

function deleteReq(projectId: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`http://localhost:3000/api/projects/${projectId}`, {
    method: "DELETE",
    headers,
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const REPO = "https://github.com/synthetic-org/synthetic-repo";

describe("PATCH /api/projects/[id]", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated and freelancer callers → 403", async () => {
    const cookiesA = await registerCompany("projitem-a@consultai.test", "ProjItem Alpha");
    await createProject(cookiesA, "projitem-alpha");

    const unauth = await projectPATCH(
      patchReq("projitem-alpha", { githubRepoUrl: REPO }),
      params("projitem-alpha")
    );
    expect(unauth.status).toBe(403);

    const freeCookies = await registerFreelancer("projitem-free@consultai.test");
    const free = await projectPATCH(
      patchReq("projitem-alpha", { githubRepoUrl: REPO }, freeCookies),
      params("projitem-alpha")
    );
    expect(free.status).toBe(403);
  });

  it("Company A cannot patch Company B's project → 403", async () => {
    const cookiesA = await registerCompany("projitem-a2@consultai.test", "ProjItem Alpha2");
    const cookiesB = await registerCompany("projitem-b@consultai.test", "ProjItem Beta");
    await createProject(cookiesB, "projitem-beta");

    const res = await projectPATCH(
      patchReq("projitem-beta", { githubRepoUrl: REPO }, cookiesA),
      params("projitem-beta")
    );
    expect(res.status).toBe(403);
    expect(getDemoTables().projects.find((p) => p.id === "projitem-beta")?.githubRepoUrl).toBeNull();
  });

  it("owner PATCH persists githubRepoUrl; invalid URLs → 400", async () => {
    const cookiesA = await registerCompany("projitem-owner@consultai.test", "ProjItem Owner");
    await createProject(cookiesA, "projitem-owner");

    const ok = await projectPATCH(
      patchReq("projitem-owner", { githubRepoUrl: REPO }, cookiesA),
      params("projitem-owner")
    );
    expect(ok.status).toBe(200);
    expect(getDemoTables().projects.find((p) => p.id === "projitem-owner")?.githubRepoUrl).toBe(REPO);

    const bad = await projectPATCH(
      patchReq("projitem-owner", { githubRepoUrl: "not-a-github-url" }, cookiesA),
      params("projitem-owner")
    );
    expect(bad.status).toBe(400);
  });
});

describe("DELETE /api/projects/[id]", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated and freelancer callers → 403", async () => {
    const cookiesA = await registerCompany("projdel-a@consultai.test", "ProjDel Alpha");
    await createProject(cookiesA, "projdel-alpha");

    expect((await projectDELETE(deleteReq("projdel-alpha"), params("projdel-alpha"))).status).toBe(403);

    const freeCookies = await registerFreelancer("projdel-free@consultai.test");
    expect(
      (await projectDELETE(deleteReq("projdel-alpha", freeCookies), params("projdel-alpha"))).status
    ).toBe(403);
    expect(getDemoTables().projects.some((p) => p.id === "projdel-alpha")).toBe(true);
  });

  it("Company A cannot delete Company B's project → 403", async () => {
    const cookiesA = await registerCompany("projdel-a2@consultai.test", "ProjDel Alpha2");
    const cookiesB = await registerCompany("projdel-b@consultai.test", "ProjDel Beta");
    await createProject(cookiesB, "projdel-beta");

    const res = await projectDELETE(deleteReq("projdel-beta", cookiesA), params("projdel-beta"));
    expect(res.status).toBe(403);
    expect(getDemoTables().projects.some((p) => p.id === "projdel-beta")).toBe(true);
  });

  it("owner DELETE cascades to child milestone rows", async () => {
    const cookiesA = await registerCompany("projdel-owner@consultai.test", "ProjDel Owner");
    await createProject(cookiesA, "projdel-owner");
    const msRes = await milestonesPOST(
      new NextRequest("http://localhost:3000/api/projects/projdel-owner/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookiesA },
        body: JSON.stringify({ title: "Doomed milestone", startDate: "2026-06-01", durationDays: 2 }),
      }),
      params("projdel-owner")
    );
    expect(msRes.status).toBe(200);
    expect(getDemoTables().milestones.some((m) => m.projectId === "projdel-owner")).toBe(true);

    const res = await projectDELETE(deleteReq("projdel-owner", cookiesA), params("projdel-owner"));
    expect(res.status).toBe(200);
    expect(getDemoTables().projects.some((p) => p.id === "projdel-owner")).toBe(false);
    expect(getDemoTables().milestones.some((m) => m.projectId === "projdel-owner")).toBe(false);
  });

  it("canonical TechNova demo project is protected from deletion → 409", async () => {
    const cookiesA = await registerCompany("projdel-canon@consultai.test", "ProjDel Canon");
    const res = await projectDELETE(
      deleteReq(DEMO_IDS.project, cookiesA),
      params(DEMO_IDS.project)
    );
    expect(res.status).toBe(409);
    expect(getDemoTables().projects.some((p) => p.id === DEMO_IDS.project)).toBe(true);
  });
});

describe("PATCH /api/projects/[id] demo rehydration (serverless-safe)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("demo miss without title → 404 preserved", async () => {
    const cookiesA = await registerCompany("patch-rh@consultai.test", "Patch Rehy");
    const res = await projectPATCH(
      patchReq("patch-ghost-no-title", { githubRepoUrl: REPO }, cookiesA),
      params("patch-ghost-no-title")
    );
    expect(res.status).toBe(404);
  });

  it("demo miss with title → 200 and repo URL persists on rehydrated row", async () => {
    const cookiesA = await registerCompany("patch-rh2@consultai.test", "Patch Rehy2");
    await createProject(cookiesA, "patch-x-instance");
    // Fresh serverless instance: the store never saw the POST.
    resetDemoStore();
    const res = await projectPATCH(
      patchReq(
        "patch-x-instance",
        { githubRepoUrl: REPO, projectTitle: "Synthetic patch-x-instance" },
        cookiesA
      ),
      params("patch-x-instance")
    );
    expect(res.status).toBe(200);
    expect(
      getDemoTables().projects.find((p) => p.id === "patch-x-instance")
        ?.githubRepoUrl
    ).toBe(REPO);
  });
});
