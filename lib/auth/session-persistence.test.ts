/**
 * Session persistence / revocation hardening tests (lib/auth/session).
 *
 * Pins strict production behavior: migration 0010 (`auth_sessions`) is a
 * hard prerequisite, so login/register return 503 when the session row
 * cannot be persisted, and validation rejects tokens whose row is missing
 * or unreadable. Demo/dev/test environments keep the degraded JWT +
 * in-memory path.
 *
 * Runs with a mocked @/lib/db (DUMMY_DATABASE_URL is never dialed): no
 * network, no migrations, no Production data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  createSessionCookie,
  getSessionFromCookie,
  isStrictSessionPersistence,
  registerUserAccount,
  resetAuthStoreForTests,
  SESSION_COOKIE_NAME,
  type AuthUserRecord,
} from "./session";
import { hashPassword } from "./password";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
const insertMock = db.insert as unknown as ReturnType<typeof vi.fn>;

const savedEnv = {
  nodeEnv: process.env.NODE_ENV,
  demoMode: process.env.DEMO_MODE,
  databaseUrl: process.env.DATABASE_URL,
  liveRequire: process.env.LIVE_REQUIRE_DB_SESSION,
  roleSecret: process.env.ROLE_COOKIE_SECRET,
  sessionSecret: process.env.SESSION_COOKIE_SECRET,
};

type SessionRow = { revokedAt: Date | null; expiresAt: Date };
let sessionRows: SessionRow[] = [];
let insertShouldFail = false;
let insertErrorCode: string | null = null;

function testUser(): AuthUserRecord {
  return {
    id: "user-strict-1",
    email: "strict@consultai.test",
    name: "Strict User",
    passwordHash: "scrypt$16384$8$1$00$00",
    role: "company",
    companyId: "company-strict-1",
    companyName: "Strict Co",
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
    createdAt: new Date().toISOString(),
  };
}

async function mintSessionCookie(): Promise<string> {
  const { sessionCookie } = await createSessionCookie(testUser());
  return sessionCookie.split(";")[0];
}

function useStrictLiveEnv() {
  process.env.NODE_ENV = "production";
  process.env.DEMO_MODE = "false";
  process.env.DATABASE_URL =
    "postgresql://test-user:test-pass@localhost:5432/testdb";
  delete process.env.LIVE_REQUIRE_DB_SESSION;
}

describe("strict session persistence (mocked db)", () => {
  beforeEach(() => {
    process.env.ROLE_COOKIE_SECRET =
      "test-role-secret-0123456789abcdef-test";
    process.env.SESSION_COOKIE_SECRET =
      "test-session-secret-0123456789abcdef-test12";
    resetAuthStoreForTests();
    vi.clearAllMocks();
    sessionRows = [];
    insertShouldFail = false;
    insertErrorCode = null;

    selectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({ limit: async () => sessionRows }),
      }),
    }));
    // values() returns a non-promise builder (drizzle shape): session writes
    // await it directly, register's company insert chains .onConflictDoNothing().
    insertMock.mockImplementation(() => ({
      values: () => {
        if (insertShouldFail) {
          const err = new Error(
            'relation "auth_sessions" does not exist'
          ) as Error & { code?: string };
          if (insertErrorCode) err.code = insertErrorCode;
          throw err;
        }
        return { onConflictDoNothing: async () => ({}) };
      },
    }));
  });

  afterEach(() => {
    const restore = (k: keyof typeof savedEnv, name: string) => {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    };
    restore("nodeEnv", "NODE_ENV");
    restore("demoMode", "DEMO_MODE");
    restore("databaseUrl", "DATABASE_URL");
    restore("liveRequire", "LIVE_REQUIRE_DB_SESSION");
    restore("roleSecret", "ROLE_COOKIE_SECRET");
    restore("sessionSecret", "SESSION_COOKIE_SECRET");
  });

  it("strict mode is on only in production live without opt-out", () => {
    useStrictLiveEnv();
    expect(isStrictSessionPersistence()).toBe(true);

    process.env.LIVE_REQUIRE_DB_SESSION = "false";
    expect(isStrictSessionPersistence()).toBe(false);

    delete process.env.LIVE_REQUIRE_DB_SESSION;
    process.env.DEMO_MODE = "true";
    expect(isStrictSessionPersistence()).toBe(false);

    process.env.DEMO_MODE = "false";
    process.env.NODE_ENV = "test";
    expect(isStrictSessionPersistence()).toBe(false);
  });

  it("createSessionCookie reports whether the row was persisted", async () => {
    useStrictLiveEnv();
    const ok = await createSessionCookie(testUser());
    expect(ok.dbPersisted).toBe(true);

    insertShouldFail = true;
    const degraded = await createSessionCookie(testUser());
    expect(degraded.dbPersisted).toBe(false);
  });

  it("strict validation rejects a token whose row is missing; degraded mode accepts", async () => {
    useStrictLiveEnv();
    sessionRows = [];
    const cookie = await mintSessionCookie();

    const strict = await getSessionFromCookie(cookie);
    expect(strict).toBeNull();

    process.env.NODE_ENV = "test";
    const degraded = await getSessionFromCookie(cookie);
    expect(degraded).not.toBeNull();
    expect(degraded?.userId).toBe("user-strict-1");
  });

  it("strict validation rejects when the table is unreadable; degraded mode accepts", async () => {
    useStrictLiveEnv();
    selectMock.mockImplementation(() => {
      throw new Error('relation "auth_sessions" does not exist');
    });
    const cookie = await mintSessionCookie();

    const strict = await getSessionFromCookie(cookie);
    expect(strict).toBeNull();

    process.env.NODE_ENV = "test";
    const degraded = await getSessionFromCookie(cookie);
    expect(degraded).not.toBeNull();
  });

  it("strict validation fails closed without a database", async () => {
    useStrictLiveEnv();
    delete process.env.DATABASE_URL;
    // Minted while degraded (no DB): memory-only session, never strict-valid.
    const cookie = await mintSessionCookie();
    const validated = await getSessionFromCookie(cookie);
    expect(validated).toBeNull();
  });

  it("a present, unrevoked, unexpired row validates in strict mode", async () => {
    useStrictLiveEnv();
    sessionRows = [
      { revokedAt: null, expiresAt: new Date(Date.now() + 3600_000) },
    ];
    const cookie = await mintSessionCookie();
    const session = await getSessionFromCookie(cookie);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-strict-1");
  });

  it("a revoked row is rejected in both modes", async () => {
    useStrictLiveEnv();
    sessionRows = [
      { revokedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) },
    ];
    const cookie = await mintSessionCookie();
    await expect(getSessionFromCookie(cookie)).resolves.toBeNull();

    process.env.NODE_ENV = "test";
    const cookie2 = await mintSessionCookie();
    await expect(getSessionFromCookie(cookie2)).resolves.toBeNull();
  });

  it("strict login returns 503 when the session row cannot persist (no cookies)", async () => {
    useStrictLiveEnv();
    insertShouldFail = true;
    const passwordHash = await hashPassword("StrictPass2026!");
    const created = await registerUserAccount({
      ...testUser(),
      passwordHash,
      termsAcceptedAt: new Date().toISOString(),
    });
    expect(created.user).toBeDefined();

    const res = await loginPOST(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "strict@consultai.test",
          password: "StrictPass2026!",
        }),
      })
    );
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("auth_unavailable");
    expect(res.headers.getSetCookie?.() ?? []).toHaveLength(0);
  });

  it("non-strict login still succeeds when the insert fails (degraded path kept)", async () => {
    useStrictLiveEnv();
    process.env.NODE_ENV = "test";
    insertShouldFail = true;

    const res = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "company",
          companyName: "Degraded Co",
          contactName: "Synthetic Owner",
          email: "degraded@consultai.test",
          password: "SyntheticPass2026!",
          termsAccepted: true,
        }),
      })
    );
    expect(res.status).toBe(201);
  });

  it("strict register returns 503 when the session row cannot persist", async () => {
    useStrictLiveEnv();
    insertShouldFail = true;

    const res = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "freelancer",
          fullName: "Synthetic Dev",
          email: "strict-reg@consultai.test",
          specialty: "Backend Engineer",
          password: "SyntheticPass2026!",
          termsAccepted: true,
        }),
      })
    );
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("auth_unavailable");
  });

  it("session cookie name is stable for the strict tests above", () => {
    expect(SESSION_COOKIE_NAME).toBe("consultai_session_v1");
  });

  it("strict login reports auth_service_misconfigured for 42P01 + requestId", async () => {
    useStrictLiveEnv();
    insertShouldFail = true;
    insertErrorCode = "42P01";
    const passwordHash = await hashPassword("StrictPass2026!");
    const created = await registerUserAccount({
      ...testUser(),
      passwordHash,
      termsAcceptedAt: new Date().toISOString(),
    });
    expect(created.user).toBeDefined();

    const res = await loginPOST(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "strict@consultai.test",
          password: "StrictPass2026!",
        }),
      })
    );
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string; requestId: string };
    expect(data.error).toBe("auth_service_misconfigured");
    expect(typeof data.requestId).toBe("string");
    expect(data.requestId.length).toBeGreaterThan(0);
  });

  it("strict register reports auth_service_misconfigured + requestId", async () => {
    useStrictLiveEnv();
    insertShouldFail = true;
    insertErrorCode = "42P01";

    const res = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "freelancer",
          fullName: "Synthetic Dev",
          email: "strict-reg-misc@consultai.test",
          specialty: "Backend Engineer",
          password: "SyntheticPass2026!",
          termsAccepted: true,
        }),
      })
    );
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string; requestId: string };
    expect(data.error).toBe("auth_service_misconfigured");
    expect(typeof data.requestId).toBe("string");
  });

  it("register uniqueness check fails closed (lookup error → 503, no phantom)", async () => {
    useStrictLiveEnv();
    selectMock.mockImplementationOnce(() => {
      throw new Error("connection reset");
    });

    const res = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "company",
          companyName: "Lookup Fail Co",
          contactName: "Synthetic Owner",
          email: "lookup-fail@consultai.test",
          password: "SyntheticPass2026!",
          termsAccepted: true,
        }),
      })
    );
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("auth_unavailable");
  });

  it("expired session token validates to null (expired session)", async () => {
    process.env.DEMO_MODE = "true";
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(
      "test-session-secret-0123456789abcdef-test12"
    );
    const expired = await new SignJWT({
      sub: "user-strict-1",
      jti: "sess-expired-1",
      email: "strict@consultai.test",
      name: "Strict User",
      role: "company",
      companyId: "company-strict-1",
      companyName: "Strict Co",
      githubHandle: null,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret);
    expect(
      await getSessionFromCookie(`${SESSION_COOKIE_NAME}=${expired}`)
    ).toBeNull();
  });

  it("missing session cookie validates to null", async () => {
    process.env.DEMO_MODE = "true";
    expect(await getSessionFromCookie(null)).toBeNull();
    expect(await getSessionFromCookie("")).toBeNull();
  });
});
