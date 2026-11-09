/**
 * Security regression tests for GET /api/sse/ai-ops.
 *
 * The AI Operations telemetry stream carries approvals and executions. These
 * tests pin the gate: unauthenticated / freelancer / role-header-forged
 * callers get 403 before any stream opens, and a company session scoped to
 * Company A is rejected when asking for Company B's project stream.
 *
 * Unit-level with mocked session/role/db modules — no live DB, no open
 * streams (success-path streaming would hold the test runner open).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/auth/session", () => ({ getSessionFromCookie: vi.fn() }));
vi.mock("@/lib/auth/role-cookie", () => ({ getRoleFromCookie: vi.fn() }));
vi.mock("@/lib/ai-ops/orchestrator-engine", () => ({
  getAiOpsDashboardSnapshot: vi.fn(),
}));

import { GET } from "./route";
import { getSessionFromCookie } from "@/lib/auth/session";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { getAiOpsDashboardSnapshot } from "@/lib/ai-ops/orchestrator-engine";
import { db } from "@/lib/db";

const mockedGetSession = vi.mocked(getSessionFromCookie);
const mockedGetRole = vi.mocked(getRoleFromCookie);
const mockedSnapshot = vi.mocked(getAiOpsDashboardSnapshot);
const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;

const CANNED_SNAPSHOT = {
  agents: [],
  executions: [],
  scheduling_proposals: [],
  payment_proposals: [],
  pending_payment_approvals: [],
  verification_runs: [],
  recent_audits: [],
};

function sseReq(projectId?: string, roleHeader?: string): NextRequest {
  const url =
    projectId != null
      ? `http://localhost/api/sse/ai-ops?projectId=${projectId}`
      : "http://localhost/api/sse/ai-ops";
  const headers: Record<string, string> = {};
  if (roleHeader) headers["X-ConsultAI-Role"] = roleHeader;
  return new NextRequest(url, { headers });
}

/** Mock the drizzle select().from().where().limit() chain to yield rows. */
function mockProjectRows(rows: Array<{ companyId: string }>): void {
  selectMock.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  });
}

const sessionA = {
  sessionId: "sess-a",
  userId: "user-a",
  email: "a@consultai.test",
  name: "Company A",
  role: "company" as const,
  companyId: "company-a",
  companyName: "Alpha",
  githubHandle: null,
  isAuthenticatedUser: true,
};

describe("GET /api/sse/ai-ops auth gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedGetSession.mockResolvedValue(null);
    mockedGetRole.mockResolvedValue(null);
    mockedSnapshot.mockResolvedValue(CANNED_SNAPSHOT);
  });

  it("unauthenticated caller → 403 (no stream opened)", async () => {
    const res = await GET(sseReq("proj-any"));
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("freelancer session → 403", async () => {
    mockedGetSession.mockResolvedValue({ ...sessionA, role: "freelancer", companyId: null });
    const res = await GET(sseReq("proj-any"));
    expect(res.status).toBe(403);
  });

  it("X-ConsultAI-Role header does not open a stream", async () => {
    const res = await GET(sseReq("proj-any", "admin"));
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("Company A session requesting Company B's project stream → 403 (company-scoped)", async () => {
    mockedGetSession.mockResolvedValue(sessionA);
    mockProjectRows([{ companyId: "company-b" }]);
    const res = await GET(sseReq("proj-beta-owned"));
    expect(res.status).toBe(403);
  });

  it("Company A session requesting a missing project → 403 (non-disclosing)", async () => {
    mockedGetSession.mockResolvedValue(sessionA);
    mockProjectRows([]);
    const res = await GET(sseReq("proj-missing"));
    expect(res.status).toBe(403);
  });

  it("Company A session without projectId → 200 stream scoped to company-a (never global)", async () => {
    mockedGetSession.mockResolvedValue(sessionA);
    // Fake timers: the success path opens a 6s-interval stream; faking the
    // clock keeps the interval from holding the runner open. Status + engine
    // scope assertions only (no body read); content scoping is pinned at the
    // engine level and by the executions route tests.
    vi.useFakeTimers();
    try {
      const res = await GET(sseReq());
      expect(res.status).toBe(200);
      // The stream start() runs during GET: the engine call is already made.
      expect(mockedSnapshot).toHaveBeenCalledWith({
        projectId: undefined,
        scopeCompanyId: "company-a",
        role: "company",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Company A session with its own projectId → engine receives project + scope", async () => {
    mockedGetSession.mockResolvedValue(sessionA);
    mockProjectRows([{ companyId: "company-a" }]);
    vi.useFakeTimers();
    try {
      const res = await GET(sseReq("proj-alpha-owned"));
      expect(res.status).toBe(200);
      expect(mockedSnapshot).toHaveBeenCalledWith({
        projectId: "proj-alpha-owned",
        scopeCompanyId: "company-a",
        role: "company",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("live session-less company holder → 403 before any stream opens", async () => {
    mockedGetSession.mockResolvedValue(null);
    mockedGetRole.mockResolvedValue("company");
    const res = await GET(sseReq());
    expect(res.status).toBe(403);
    expect(mockedSnapshot).not.toHaveBeenCalled();
  });

  it("session expiring mid-stream terminates the stream (per-event scope, A)", async () => {
    mockedGetSession.mockResolvedValue(sessionA);
    vi.useFakeTimers();
    try {
      const res = await GET(sseReq());
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader?.read();
      expect(first?.done).toBe(false);
      const firstText = first?.value
        ? new TextDecoder().decode(first.value)
        : "";
      expect(firstText).toContain("event: snapshot");

      // The session expires: the next tick must terminate the stream
      // instead of emitting another scoped snapshot.
      mockedGetSession.mockResolvedValue(null);
      mockedGetRole.mockResolvedValue(null);
      const nextRead = reader?.read();
      await vi.advanceTimersByTimeAsync(6000);
      const second = await nextRead;
      expect(second?.done).toBe(false);
      const secondText = second?.value
        ? new TextDecoder().decode(second.value)
        : "";
      expect(secondText).toContain("session_expired");
      const end = await reader?.read();
      expect(end?.done).toBe(true);
      // Only the initial snapshot was ever built — nothing after expiry.
      expect(mockedSnapshot).toHaveBeenCalledTimes(1);
      await reader?.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });
});
