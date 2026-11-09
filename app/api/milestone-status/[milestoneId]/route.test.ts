/**
 * Auth gate regression tests for GET /api/milestone-status/[milestoneId].
 *
 * This endpoint exposes PayPal order/capture/payout IDs, amounts, and audit
 * entries. It was previously unauthenticated; these tests pin the gate:
 * company/admin role required, everyone else gets 403 before any DB access.
 *
 * Unit-level with mocks — no live DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/demo/config", () => ({ isDemoMode: () => false }));
vi.mock("@/lib/demo/store", () => ({ getDemoTables: vi.fn() }));
vi.mock("@/lib/auth/role-cookie", () => ({ getRoleFromCookie: vi.fn() }));
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    getSessionFromCookie: vi.fn(),
    companySessionAllowsLiveAccess: actual.companySessionAllowsLiveAccess,
  };
});

import { GET } from "./route";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { getSessionFromCookie } from "@/lib/auth/session";

const mockedGetRole = vi.mocked(getRoleFromCookie);
const mockedGetSession = vi.mocked(getSessionFromCookie);

function getReq(): NextRequest {
  return new NextRequest("http://localhost/api/milestone-status/ms-1");
}

function params() {
  return { params: Promise.resolve({ milestoneId: "ms-1" }) };
}

describe("GET /api/milestone-status/[milestoneId] auth gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedGetSession.mockResolvedValue(null);
  });

  it("unauthenticated request (no session, no role) → 403", async () => {
    mockedGetRole.mockResolvedValue(null);
    const res = await GET(getReq(), params());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("forbidden");
  });

  it("freelancer session → 403", async () => {
    mockedGetSession.mockResolvedValue({
      sessionId: "sess-1",
      userId: "user-1",
      email: "free@example.com",
      name: "Free",
      role: "freelancer",
      companyId: null,
      companyName: null,
      githubHandle: "free",
      isAuthenticatedUser: true,
    });
    const res = await GET(getReq(), params());
    expect(res.status).toBe(403);
  });

  it("freelancer role cookie (no session) → 403", async () => {
    mockedGetRole.mockResolvedValue("freelancer");
    const res = await GET(getReq(), params());
    expect(res.status).toBe(403);
  });

  it("live session-less company cookie → 403 missing_company_context (D.3)", async () => {
    mockedGetRole.mockResolvedValue("company");
    const res = await GET(getReq(), params());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("missing_company_context");
  });

  it("live company session without companyId → 403 (no unscoped read)", async () => {
    mockedGetSession.mockResolvedValue({
      sessionId: "sess-1",
      userId: "user-1",
      email: "owner@example.com",
      name: "Owner",
      role: "company",
      companyId: null,
      companyName: null,
      githubHandle: null,
      isAuthenticatedUser: true,
    });
    const res = await GET(getReq(), params());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("missing_company_context");
  });
});
