/**
 * POST /api/admin/provision-demo-users tests: secret gating, idempotent
 * creation of the two fixed demo accounts, and rate limiting.
 *
 * Mocked-db unit level: no live database, no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn(), insert: vi.fn() } }));

import { POST } from "./route";
import { db } from "@/lib/db";
import {
  DEMO_COMPANY_EMAIL,
  DEMO_FREELANCER_EMAIL,
} from "@/lib/seed/demo-users";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
const insertMock = db.insert as unknown as ReturnType<typeof vi.fn>;

const SECRET = "test-internal-secret-0123456789abcdef";

function provisionReq(ip: string, secret?: string): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": ip,
  };
  if (secret !== undefined) headers["x-provision-secret"] = secret;
  return new NextRequest(
    "http://localhost:3000/api/admin/provision-demo-users",
    { method: "POST", headers }
  );
}

/** Resolve every select().from().where().limit() chain with `rows`. */
function mockSelectRows(rows: Array<{ id: string }>): void {
  selectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  });
}

/** Record every insert().values(v) payload; onConflictDoNothing resolves. */
function mockInsertRecorder(recorded: unknown[]): void {
  insertMock.mockReturnValue({
    values: (v: unknown) => {
      recorded.push(v);
      return { onConflictDoNothing: async () => undefined };
    },
  });
}

describe("POST /api/admin/provision-demo-users", () => {
  const savedSecret = process.env.INTERNAL_API_SECRET;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.INTERNAL_API_SECRET = SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = savedSecret;
  });

  it("rejects requests without the provisioning secret (no writes)", async () => {
    mockSelectRows([]);
    mockInsertRecorder([]);
    const res = await POST(provisionReq("10.0.0.1"));
    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects requests with a wrong secret", async () => {
    mockSelectRows([]);
    mockInsertRecorder([]);
    const res = await POST(provisionReq("10.0.0.2", "wrong-secret"));
    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("fails closed when INTERNAL_API_SECRET is unconfigured", async () => {
    delete process.env.INTERNAL_API_SECRET;
    mockSelectRows([]);
    mockInsertRecorder([]);
    const res = await POST(provisionReq("10.0.0.3", SECRET));
    expect(res.status).toBe(503);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("creates both fixed demo accounts with scrypt hashes when absent", async () => {
    mockSelectRows([]);
    const recorded: unknown[] = [];
    mockInsertRecorder(recorded);
    const res = await POST(provisionReq("10.0.0.4", SECRET));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      users: Array<{ email: string; status: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.users).toEqual([
      { email: DEMO_COMPANY_EMAIL, status: "created" },
      { email: DEMO_FREELANCER_EMAIL, status: "created" },
    ]);
    // 1 company insert + 2 user inserts
    expect(insertMock).toHaveBeenCalledTimes(3);
    const userRows = recorded.slice(1) as Array<{
      email: string;
      role: string;
      passwordHash: string;
    }>;
    expect(userRows[0].email).toBe(DEMO_COMPANY_EMAIL);
    expect(userRows[0].role).toBe("company");
    expect(userRows[1].email).toBe(DEMO_FREELANCER_EMAIL);
    expect(userRows[1].role).toBe("freelancer");
    for (const row of userRows) {
      expect(row.passwordHash.startsWith("scrypt$")).toBe(true);
    }
    // Never leaks hashes in the response
    expect(JSON.stringify(body)).not.toContain("scrypt$");
  });

  it("skips existing accounts without overwriting them", async () => {
    mockSelectRows([{ id: "existing" }]);
    const recorded: unknown[] = [];
    mockInsertRecorder(recorded);
    const res = await POST(provisionReq("10.0.0.5", SECRET));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ email: string; status: string }>;
    };
    expect(body.users).toEqual([
      { email: DEMO_COMPANY_EMAIL, status: "skipped_exists" },
      { email: DEMO_FREELANCER_EMAIL, status: "skipped_exists" },
    ]);
    // Company insert only — no user writes
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("rate-limits repeated calls from the same IP", async () => {
    mockSelectRows([{ id: "existing" }]);
    mockInsertRecorder([]);
    const ip = "10.0.0.6";
    for (let i = 0; i < 5; i++) {
      const res = await POST(provisionReq(ip, SECRET));
      expect(res.status).toBe(200);
    }
    const limited = await POST(provisionReq(ip, SECRET));
    expect(limited.status).toBe(429);
  });
});
