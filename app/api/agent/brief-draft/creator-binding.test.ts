/**
 * Creator-binding + live permission tests for POST /api/agent/brief-draft.
 *
 * Pins the fix for cross-user draft overwrite: the client-supplied
 * `agentSessionId` is namespaced by the authenticated creator, so a
 * same-company caller replaying another user's id writes a different row
 * instead of overwriting their draft. Also pins the live session gate:
 * session-less role holders cannot write drafts to any project.
 *
 * Live-mode tests run with a mocked @/lib/db (no DATABASE_URL, no network,
 * no Production data). Demo-mode parity is covered by route.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as draftPOST } from "./route";
import { creatorScopedKey } from "@/lib/brief/creator-scope";
import {
  getSessionFromCookie,
  resetAuthStoreForTests,
} from "@/lib/auth/session";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
const insertMock = db.insert as unknown as ReturnType<typeof vi.fn>;
const updateMock = db.update as unknown as ReturnType<typeof vi.fn>;

let projectRows: Array<{ companyId: string }> = [];
let draftRows: Array<{ id: string }> = [];
let insertedValues: Array<Record<string, unknown>> = [];
let updateSets: Array<Record<string, unknown>> = [];

function draftReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost:3000/api/agent/brief-draft", {
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
  return {
    cookies,
    userId: session.userId,
    companyId: session.companyId,
  };
}

describe("brief-draft creator binding (live, mocked db)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "false";
    delete process.env.DATABASE_URL;
    process.env.ROLE_COOKIE_SECRET =
      "test-role-secret-0123456789abcdef-test";
    process.env.SESSION_COOKIE_SECRET =
      "test-session-secret-0123456789abcdef-test12";
    resetAuthStoreForTests();
    vi.clearAllMocks();
    projectRows = [];
    draftRows = [];
    insertedValues = [];
    updateSets = [];

    selectMock.mockImplementation((fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            fields && "companyId" in fields ? projectRows : draftRows,
        }),
      }),
    }));
    insertMock.mockImplementation(() => ({
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return Promise.resolve({});
      },
    }));
    updateMock.mockImplementation(() => ({
      set: (vals: Record<string, unknown>) => {
        updateSets.push(vals);
        return { where: async () => ({}) };
      },
    }));
  });

  it("creatorScopedKey is deterministic and separates creators and sessions", () => {
    expect(creatorScopedKey("user-a", "sess-1")).toBe("user-a:sess-1");
    expect(creatorScopedKey("user-a", "sess-1")).toBe(
      creatorScopedKey("user-a", "sess-1")
    );
    expect(creatorScopedKey("user-a", "sess-1")).not.toBe(
      creatorScopedKey("user-b", "sess-1")
    );
    expect(creatorScopedKey("user-a", "sess-1")).not.toBe(
      creatorScopedKey("user-a", "sess-2")
    );
  });

  it("live unauthenticated caller → 403 before any DB access", async () => {
    const res = await draftPOST(
      draftReq({ projectId: "proj-live-1", agentSessionId: "sess1" })
    );
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("live session-less company role holder → 403 before any DB access", async () => {
    const cookie = (await signRoleCookie("company")).split(";")[0];
    const res = await draftPOST(
      draftReq({ projectId: "proj-live-1", agentSessionId: "sess1" }, cookie)
    );
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("live session-less admin role holder → 403 (writes need a session)", async () => {
    const cookie = (await signRoleCookie("admin")).split(";")[0];
    const res = await draftPOST(
      draftReq({ projectId: "proj-live-1", agentSessionId: "sess1" }, cookie)
    );
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("live company session stores the draft under the creator-scoped key", async () => {
    const user = await registerCompany(
      "bind-a@consultai.test",
      "Bind Alpha"
    );
    projectRows = [{ companyId: user.companyId }];
    draftRows = [];

    const res = await draftPOST(
      draftReq(
        { projectId: "proj-live-1", agentSessionId: "shared_sess", plan: {} },
        user.cookies
      )
    );
    expect(res.status).toBe(200);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].projectId).toBe("proj-live-1");
    expect(insertedValues[0].agentSessionId).toBe(
      `${user.userId}:shared_sess`
    );
    expect(updateSets).toHaveLength(0);
  });

  it("a second user replaying the same id writes a different row (no overwrite)", async () => {
    const userA = await registerCompany("bind2-a@consultai.test", "Bind2 A");
    const userB = await registerCompany("bind2-b@consultai.test", "Bind2 B");

    projectRows = [{ companyId: userA.companyId }];
    draftRows = [];
    const resA = await draftPOST(
      draftReq(
        { projectId: "proj-a", agentSessionId: "replayed_sess", plan: {} },
        userA.cookies
      )
    );
    expect(resA.status).toBe(200);

    projectRows = [{ companyId: userB.companyId }];
    draftRows = [];
    const resB = await draftPOST(
      draftReq(
        { projectId: "proj-b", agentSessionId: "replayed_sess", plan: {} },
        userB.cookies
      )
    );
    expect(resB.status).toBe(200);

    expect(insertedValues).toHaveLength(2);
    const keyA = insertedValues[0].agentSessionId;
    const keyB = insertedValues[1].agentSessionId;
    expect(keyA).toBe(`${userA.userId}:replayed_sess`);
    expect(keyB).toBe(`${userB.userId}:replayed_sess`);
    expect(keyA).not.toBe(keyB);
  });

  it("existing creator-scoped draft takes the update path → 200", async () => {
    const user = await registerCompany("bind-c@consultai.test", "Bind Gamma");
    projectRows = [{ companyId: user.companyId }];
    draftRows = [{ id: "draft-existing" }];

    const res = await draftPOST(
      draftReq(
        {
          projectId: "proj-live-1",
          agentSessionId: "sess_update",
          plan: { v: 2 },
        },
        user.cookies
      )
    );
    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    expect(insertedValues).toHaveLength(0);
  });

  it("live cross-company draft write → 403 with no insert or update", async () => {
    const user = await registerCompany("bind-d@consultai.test", "Bind Delta");
    projectRows = [{ companyId: "company-other" }];
    draftRows = [];

    const res = await draftPOST(
      draftReq(
        { projectId: "proj-other", agentSessionId: "sess_x", plan: {} },
        user.cookies
      )
    );
    expect(res.status).toBe(403);
    expect(insertedValues).toHaveLength(0);
    expect(updateSets).toHaveLength(0);
  });
});
