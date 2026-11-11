/**
 * POST /api/candidates/hire tests: role gating, ownership, state-machine
 * enforcement, idempotency, demo parity, and freelancer-account matching.
 *
 * Mocked-db unit level: drizzle chains are stubbed; the session store is
 * real (in-memory). No live database, no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db/audit", () => ({ writeAuditLog: vi.fn() }));

import { POST } from "./route";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/db/audit";
import {
  createSessionCookie,
  registerUserAccount,
  resetAuthStoreForTests,
} from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { getDemoTables, resetDemoStore } from "@/lib/demo/store";
import { DEMO_IDS } from "@/lib/demo/config";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
const insertMock = db.insert as unknown as ReturnType<typeof vi.fn>;
const updateMock = db.update as unknown as ReturnType<typeof vi.fn>;
const auditMock = writeAuditLog as unknown as ReturnType<typeof vi.fn>;

/** Select chain resolving `rows`, supporting both `.where()` and `.where().limit()` terminals. */
function selectRows(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve),
      }),
    }),
  };
}

function hireReq(
  ip: string,
  body: unknown,
  sessionCookie?: string
): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": ip,
  };
  if (sessionCookie) headers.Cookie = sessionCookie;
  return new NextRequest("http://localhost:3000/api/candidates/hire", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function companySessionCookie(
  email: string,
  companyId: string
): Promise<string> {
  const reg = await registerUserAccount({
    email,
    name: "Company Owner",
    passwordHash: await hashPassword("CompanyPass2026!"),
    role: "company",
    companyId,
    companyName: "Test Co",
    industry: null,
    companyWebsite: null,
    companySize: null,
    billingCountry: null,
    title: "Owner",
    githubHandle: null,
    portfolioUrl: null,
    skills: [],
    bio: null,
    hourlyRateUsd: null,
    availability: null,
    termsAcceptedAt: new Date().toISOString(),
  });
  if (!reg.user) throw new Error("registration failed in test setup");
  const { sessionCookie } = await createSessionCookie(reg.user);
  return sessionCookie.split(";")[0];
}

async function freelancerSessionCookie(email: string): Promise<string> {
  const reg = await registerUserAccount({
    email,
    name: "Freelancer",
    passwordHash: await hashPassword("FreelancerPass2026!"),
    role: "freelancer",
    companyId: null,
    companyName: null,
    industry: null,
    companyWebsite: null,
    companySize: null,
    billingCountry: null,
    title: "Engineer",
    githubHandle: null,
    portfolioUrl: null,
    skills: [],
    bio: null,
    hourlyRateUsd: null,
    availability: "available",
    termsAcceptedAt: new Date().toISOString(),
  });
  if (!reg.user) throw new Error("registration failed in test setup");
  const { sessionCookie } = await createSessionCookie(reg.user);
  return sessionCookie.split(";")[0];
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cand-1",
    projectId: "proj-1",
    name: "@someone",
    email: "someone@github.placeholder",
    githubHandle: "someone",
    status: "booking_unlocked",
    ...overrides,
  };
}

describe("POST /api/candidates/hire", () => {
  const saved = {
    demo: process.env.DEMO_MODE,
    dbUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    roleSecret: process.env.ROLE_COOKIE_SECRET,
    sessionSecret: process.env.SESSION_COOKIE_SECRET,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEMO_MODE = "";
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "test";
    process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.SESSION_COOKIE_SECRET = "fedcba9876543210fedcba9876543210";
    resetAuthStoreForTests();
    resetDemoStore();
    insertMock.mockReturnValue({
      values: () => ({ onConflictDoNothing: async () => undefined }),
    });
    updateMock.mockReturnValue({
      set: () => ({ where: async () => [] }),
    });
  });

  afterEach(() => {
    process.env.DEMO_MODE = saved.demo;
    if (saved.dbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.dbUrl;
    process.env.NODE_ENV = saved.nodeEnv;
    if (saved.roleSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
    else process.env.ROLE_COOKIE_SECRET = saved.roleSecret;
    if (saved.sessionSecret === undefined)
      delete process.env.SESSION_COOKIE_SECRET;
    else process.env.SESSION_COOKIE_SECRET = saved.sessionSecret;
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("rejects unauthenticated callers before touching data", async () => {
    const res = await POST(
      hireReq("10.1.0.1", { candidateId: "c", projectId: "p" })
    );
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("rejects freelancer sessions", async () => {
    const cookie = await freelancerSessionCookie("fl-403@example.com");
    const res = await POST(
      hireReq("10.1.0.2", { candidateId: "c", projectId: "p" }, cookie)
    );
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("validates candidateId/projectId presence", async () => {
    const cookie = await companySessionCookie("co-400@example.com", "company-1");
    const res = await POST(hireReq("10.1.0.3", { projectId: "p" }, cookie));
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown candidates", async () => {
    const cookie = await companySessionCookie("co-404@example.com", "company-1");
    selectMock.mockReturnValue(selectRows([]));
    const res = await POST(
      hireReq("10.1.0.4", { candidateId: "nope", projectId: "p" }, cookie)
    );
    expect(res.status).toBe(404);
  });

  it("rejects cross-company hires", async () => {
    const cookie = await companySessionCookie("co-x@example.com", "company-1");
    selectMock
      .mockReturnValueOnce(selectRows([candidateRow()]))
      .mockReturnValueOnce(selectRows([{ companyId: "company-OTHER" }]));
    const res = await POST(
      hireReq(
        "10.1.0.5",
        { candidateId: "cand-1", projectId: "proj-1" },
        cookie
      )
    );
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("hires from booking_unlocked and reports no matched account", async () => {
    const cookie = await companySessionCookie("co-hire@example.com", "company-1");
    const updates: unknown[] = [];
    updateMock.mockReturnValue({
      set: (v: unknown) => {
        updates.push(v);
        return { where: async () => [] };
      },
    });
    selectMock
      .mockReturnValueOnce(selectRows([candidateRow()]))
      .mockReturnValueOnce(selectRows([{ companyId: "company-1" }]));
    const res = await POST(
      hireReq(
        "10.1.0.6",
        { candidateId: "cand-1", projectId: "proj-1" },
        cookie
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      status: "selected",
      previousStatus: "booking_unlocked",
      freelancerAccountMatched: false,
    });
    expect(updates).toEqual([
      expect.objectContaining({ status: "selected" }),
    ]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "CANDIDATE_HIRED" })
    );
  });

  it("hires from meeting_held (canonical path)", async () => {
    const cookie = await companySessionCookie("co-mh@example.com", "company-1");
    selectMock
      .mockReturnValueOnce(
        selectRows([candidateRow({ status: "meeting_held" })])
      )
      .mockReturnValueOnce(selectRows([{ companyId: "company-1" }]));
    const res = await POST(
      hireReq(
        "10.1.0.7",
        { candidateId: "cand-1", projectId: "proj-1" },
        cookie
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: "selected" });
  });

  it("rejects hire from pre-NDA states with 422", async () => {
    const cookie = await companySessionCookie("co-422@example.com", "company-1");
    selectMock
      .mockReturnValueOnce(selectRows([candidateRow({ status: "shortlisted" })]))
      .mockReturnValueOnce(selectRows([{ companyId: "company-1" }]));
    const res = await POST(
      hireReq(
        "10.1.0.8",
        { candidateId: "cand-1", projectId: "proj-1" },
        cookie
      )
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_candidate_state");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("is idempotent when already selected (no rewrite)", async () => {
    const cookie = await companySessionCookie("co-idem@example.com", "company-1");
    selectMock
      .mockReturnValueOnce(selectRows([candidateRow({ status: "selected" })]))
      .mockReturnValueOnce(selectRows([{ companyId: "company-1" }]));
    const res = await POST(
      hireReq(
        "10.1.0.9",
        { candidateId: "cand-1", projectId: "proj-1" },
        cookie
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, alreadySelected: true });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reports a matched freelancer account by email", async () => {
    const cookie = await companySessionCookie("co-mail@example.com", "company-1");
    selectMock
      .mockReturnValueOnce(
        selectRows([
          candidateRow({
            email: "alex.rivera@freelancer-demo.consultai.local",
            githubHandle: null,
          }),
        ])
      )
      .mockReturnValueOnce(selectRows([{ companyId: "company-1" }]));
    const res = await POST(
      hireReq(
        "10.1.0.10",
        { candidateId: "cand-1", projectId: "proj-1" },
        cookie
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ freelancerAccountMatched: true });
  });

  it("reports a matched freelancer account by handle (live DB)", async () => {
    process.env.DATABASE_URL = "postgresql://test/test";
    // Setup queries (registration + session) resolve empty.
    selectMock.mockReturnValue(selectRows([]));
    const cookie = await companySessionCookie("co-hnd@example.com", "company-1");
    // Fresh mocks for the hire call itself (setup queries above are done).
    vi.resetAllMocks();
    insertMock.mockReturnValue({
      values: () => ({ onConflictDoNothing: async () => undefined }),
    });
    updateMock.mockReturnValue({
      set: () => ({ where: async () => [] }),
    });
    // Order: session row lookup, candidate, project, email lookup (miss), handle lookup (hit).
    selectMock
      .mockReturnValueOnce(selectRows([]))
      .mockReturnValueOnce(
        selectRows([
          candidateRow({
            email: "ghost@github.placeholder",
            githubHandle: "Matched-Handle",
          }),
        ])
      )
      .mockReturnValueOnce(selectRows([{ companyId: "company-1" }]))
      .mockReturnValueOnce(selectRows([]))
      .mockReturnValueOnce(selectRows([{ id: "user-handle-match" }]));
    const res = await POST(
      hireReq(
        "10.1.0.11",
        { candidateId: "cand-1", projectId: "proj-1" },
        cookie
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ freelancerAccountMatched: true });
  });

  it("hires in demo mode against fixtures", async () => {
    process.env.DEMO_MODE = "true";
    const tables = getDemoTables();
    const maya = tables.candidates.find((c) => c.id === DEMO_IDS.candidates.maya);
    if (!maya) throw new Error("demo fixture missing");
    maya.status = "booking_unlocked";
    const cookie = await companySessionCookie(
      "co-demo@example.com",
      DEMO_IDS.company
    );
    const res = await POST(
      hireReq(
        "10.1.0.12",
        { candidateId: maya.id, projectId: maya.projectId },
        cookie
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: "selected", simulated: true });
    expect(maya.status).toBe("selected");
  });
});
