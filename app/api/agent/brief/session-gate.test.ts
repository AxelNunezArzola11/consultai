/**
 * Live permission + creator-bound quota tests for POST /api/agent/brief.
 *
 * Pins the live session gate (session-less role holders are rejected before
 * any project, quota, or LLM access) and pins that the rate-limit quota key
 * is namespaced by the authenticated creator, so rotating the
 * client-supplied id cannot evade the per-user quota.
 *
 * Runs with mocked @/lib/db and @/lib/brief/rate-limit: no DATABASE_URL, no
 * LLM network calls, no Production data. Demo-mode parity is covered by
 * route.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

vi.mock("@/lib/brief/rate-limit", () => ({
  checkBriefRateLimit: vi.fn(async () => ({ allowed: true, callCount: 1 })),
}));

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { checkBriefRateLimit } from "@/lib/brief/rate-limit";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as briefPOST } from "./route";
import {
  getSessionFromCookie,
  resetAuthStoreForTests,
} from "@/lib/auth/session";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
const rateMock = checkBriefRateLimit as unknown as ReturnType<typeof vi.fn>;

let projectRows: Array<{ id: string; companyId: string }> = [];
const savedGroqKey = process.env.GROQ_API_KEY;

function briefReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost:3000/api/agent/brief", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function registerCompany(
  email: string,
  companyName: string
): Promise<{ cookies: string; userId: string; companyId: string }> {
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
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookies = setCookies.map((c) => c.split(";")[0]).join("; ");
  const session = await getSessionFromCookie(cookies);
  expect(session).not.toBeNull();
  if (!session || !session.companyId) {
    throw new Error("test setup: company session was not issued");
  }
  return { cookies, userId: session.userId, companyId: session.companyId };
}

describe("brief live session gate + creator-bound quota (mocked db)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "false";
    delete process.env.DATABASE_URL;
    delete process.env.GROQ_API_KEY;
    process.env.ROLE_COOKIE_SECRET =
      "test-role-secret-0123456789abcdef-test";
    process.env.SESSION_COOKIE_SECRET =
      "test-session-secret-0123456789abcdef-test12";
    resetAuthStoreForTests();
    vi.clearAllMocks();
    projectRows = [];
    selectMock.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => projectRows }) }),
    });
  });

  afterAll(() => {
    if (savedGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedGroqKey;
  });

  const body = {
    projectId: "proj-live-1",
    agentSessionId: "brief_sess_live1",
    messages: [],
  };

  it("live unauthenticated caller → 403 before quota or DB access", async () => {
    const res = await briefPOST(briefReq(body));
    expect(res.status).toBe(403);
    expect(rateMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("live session-less company role holder → 403 before quota or DB access", async () => {
    const cookie = (await signRoleCookie("company")).split(";")[0];
    const res = await briefPOST(briefReq(body, cookie));
    expect(res.status).toBe(403);
    expect(rateMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("live freelancer session → 403 (role gate, no quota consumed)", async () => {
    const res = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "freelancer",
          fullName: "Synthetic Dev",
          email: "brief-gate-free@consultai.test",
          specialty: "Backend Engineer",
          password: "SyntheticPass2026!",
          termsAccepted: true,
        }),
      })
    );
    expect(res.status).toBe(201);
    const cookies = (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");
    const denied = await briefPOST(briefReq(body, cookies));
    expect(denied.status).toBe(403);
    expect(rateMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("live company session consumes quota under the creator-scoped key", async () => {
    const user = await registerCompany(
      "brief-quota@consultai.test",
      "Brief Quota Co"
    );
    projectRows = [{ id: "proj-live-1", companyId: user.companyId }];

    // No GROQ_API_KEY in this environment: the handler deterministically
    // returns 503 after the quota check. The assertion that matters is the
    // captured quota key.
    const res = await briefPOST(briefReq(body, user.cookies));
    expect(res.status).toBe(503);
    expect(rateMock).toHaveBeenCalledTimes(1);
    expect(rateMock).toHaveBeenCalledWith(
      `${user.userId}:brief_sess_live1`
    );
  });

  it("live cross-company brief → 403", async () => {
    const user = await registerCompany(
      "brief-cross@consultai.test",
      "Brief Cross Co"
    );
    projectRows = [{ id: "proj-live-1", companyId: "company-other" }];

    const res = await briefPOST(briefReq(body, user.cookies));
    expect(res.status).toBe(403);
  });
});
