/**
 * Security regression tests for POST /api/agent/brief-draft.
 *
 * Brief drafts were historically an open DB write; these tests pin the
 * hardened gate: unauthenticated / freelancer / role-header-forged callers
 * get 403 before any validation or store access, and Company A cannot
 * save drafts against Company B's project.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as draftPOST } from "./route";
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

function draftReq(body: unknown, init: { cookie?: string; roleHeader?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.roleHeader) headers["X-ConsultAI-Role"] = init.roleHeader;
  return new NextRequest("http://localhost:3000/api/agent/brief-draft", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  projectId: DEMO_IDS.project,
  agentSessionId: "draft_sess_synthetic7",
  plan: { milestones: [] },
};

describe("POST /api/agent/brief-draft auth gate", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("unauthenticated caller cannot create a brief draft → 403", async () => {
    const res = await draftPOST(draftReq(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it("freelancer session → 403", async () => {
    const freeCookies = await registerFreelancer("draft-free@consultai.test");
    const res = await draftPOST(draftReq(VALID_BODY, { cookie: freeCookies }));
    expect(res.status).toBe(403);
  });

  it("X-ConsultAI-Role header does not escalate to draft writes", async () => {
    const forged = await draftPOST(draftReq(VALID_BODY, { roleHeader: "admin" }));
    expect(forged.status).toBe(403);

    const freeCookies = await registerFreelancer("draft-free-escalate@consultai.test");
    const escalated = await draftPOST(
      draftReq(VALID_BODY, { cookie: freeCookies, roleHeader: "admin" })
    );
    expect(escalated.status).toBe(403);
  });

  it("Company A cannot save drafts against Company B's project → 403", async () => {
    const cookiesA = await registerCompany("draft-a@consultai.test", "Draft Alpha");
    const cookiesB = await registerCompany("draft-b@consultai.test", "Draft Beta");
    const createRes = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookiesB },
        body: JSON.stringify({ projectId: "draft-proj-beta", title: "Draft Beta" }),
      })
    );
    expect(createRes.status).toBe(201);

    const res = await draftPOST(
      draftReq({ ...VALID_BODY, projectId: "draft-proj-beta" }, { cookie: cookiesA })
    );
    expect(res.status).toBe(403);
  });

  it("company role holder saves a simulated draft; malformed sessions → 400", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const ok = await draftPOST(draftReq(VALID_BODY, { cookie: companyCookie }));
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { ok: boolean; id: string; simulated: boolean };
    expect(data.ok).toBe(true);
    expect(data.id).toBe("draft_sess_synthetic7");
    expect(data.simulated).toBe(true);

    const bad = await draftPOST(
      draftReq({ ...VALID_BODY, agentSessionId: "not a valid session!!" }, { cookie: companyCookie })
    );
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/agent/brief-draft demo rehydration (serverless-safe)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("session-company miss without title → 403 preserved", async () => {
    const cookiesA = await registerCompany("draft-rh@consultai.test", "Draft Rehy");
    const res = await draftPOST(
      draftReq(
        { ...VALID_BODY, projectId: "draft-ghost-no-title" },
        { cookie: cookiesA }
      )
    );
    expect(res.status).toBe(403);
  });

  it("session-company miss with title → 200 ok (rehydrated)", async () => {
    const cookiesA = await registerCompany("draft-rh2@consultai.test", "Draft Rehy2");
    const createRes = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookiesA },
        body: JSON.stringify({ projectId: "draft-x-instance", title: "Draft X" }),
      })
    );
    expect(createRes.status).toBe(201);
    // Fresh serverless instance: the store never saw the POST.
    resetDemoStore();
    const res = await draftPOST(
      draftReq(
        {
          ...VALID_BODY,
          projectId: "draft-x-instance",
          projectTitle: "Draft X",
        },
        { cookie: cookiesA }
      )
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});
