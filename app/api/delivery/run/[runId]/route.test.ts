/**
 * Auth + assignment regression tests for GET /api/delivery/run/[runId] (D.2/D.3).
 *
 * Verification runs carry agent steps and payment proposals (financial), so
 * run reads are scoped like verify writes: live mode requires a verified
 * session, company sessions are project-scoped (D.3), and freelancer
 * sessions are assignment-scoped by session email and/or GitHub handle
 * with missing identity failing closed (D.2).
 *
 * Unit-level with mocked session/role/db modules — gate assertions only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    getSessionFromCookie: vi.fn(),
    companySessionAllowsLiveAccess: actual.companySessionAllowsLiveAccess,
  };
});
vi.mock("@/lib/auth/role-cookie", () => ({ getRoleFromCookie: vi.fn() }));

import { GET } from "./route";
import { getSessionFromCookie } from "@/lib/auth/session";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { db } from "@/lib/db";

const mockedGetSession = vi.mocked(getSessionFromCookie);
const mockedGetRole = vi.mocked(getRoleFromCookie);
const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;

function runReq(): NextRequest {
  return new NextRequest("http://localhost:3000/api/delivery/run/run-1");
}

function runParams() {
  return { params: Promise.resolve({ runId: "run-1" }) };
}

function freelancerSession(email: string, githubHandle: string | null) {
  return {
    sessionId: "sess-free",
    userId: "user-free",
    email,
    name: "Synthetic Dev",
    role: "freelancer" as const,
    companyId: null,
    companyName: null,
    githubHandle,
    isAuthenticatedUser: true,
  };
}

/** Queue one drizzle select().from().where().limit() result. */
function mockSelectOnce(rows: unknown[]): void {
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  });
}

describe("GET /api/delivery/run/[runId] auth + assignment gates", () => {
  const prevDemo = process.env.DEMO_MODE;
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEMO_MODE = "";
    mockedGetSession.mockResolvedValue(null);
    mockedGetRole.mockResolvedValue(null);
  });
  afterEach(() => {
    process.env.DEMO_MODE = prevDemo;
  });

  it("unauthenticated caller → 401", async () => {
    const res = await GET(runReq(), runParams());
    expect(res.status).toBe(401);
  });

  it("live session-less company cookie → 403 missing_company_context (D.3)", async () => {
    mockedGetRole.mockResolvedValue("company");
    const res = await GET(runReq(), runParams());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_company_context"
    );
  });

  it("live session-less freelancer cookie → 403 missing_freelancer_identity (D.2)", async () => {
    mockedGetRole.mockResolvedValue("freelancer");
    const res = await GET(runReq(), runParams());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_freelancer_identity"
    );
  });

  it("live freelancer session without email or handle → 403 (no silent bypass)", async () => {
    mockedGetSession.mockResolvedValue(freelancerSession("", null));
    const res = await GET(runReq(), runParams());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_freelancer_identity"
    );
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("live freelancer session with identity but unassigned → 403 (check ran)", async () => {
    mockedGetSession.mockResolvedValue(
      freelancerSession("dev@consultai.test", "devhandle")
    );
    mockSelectOnce([{ id: "run-1", milestoneId: "ms-1" }]);
    mockSelectOnce([{ projectId: "proj-1" }]);
    mockSelectOnce([
      { email: "other@consultai.test", githubHandle: "otherhandle" },
    ]);
    const res = await GET(runReq(), runParams());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });
});
