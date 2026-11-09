/**
 * POST /api/auth/login regression tests: normal sign-in, documented demo
 * accounts, production seed gating, and honest 503 vs 401 behavior.
 *
 * The two documented demo accounts (see the login page quick-fill and
 * lib/auth/session.ts seeds) are:
 *   - founder@acme-demo.consultai.local / DemoCompany2026!      (company)
 *   - alex.rivera@freelancer-demo.consultai.local / DemoFreelancer2026! (freelancer)
 *
 * Memory-store + mocked-db unit level: no live database, no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn(), insert: vi.fn() } }));

import { POST as loginPOST } from "./route";
import { POST as registerPOST } from "../register/route";
import { POST as logoutPOST } from "../logout/route";
import { GET as executionsGET } from "@/app/api/ai-ops/executions/route";
import {
  getSessionFromCookie,
  resetAuthStoreForTests,
} from "@/lib/auth/session";
import { getDemoTables, resetDemoStore } from "@/lib/demo/store";
import { db } from "@/lib/db";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;

const DEMO_COMPANY_EMAIL = "founder@acme-demo.consultai.local";
const DEMO_COMPANY_PASSWORD = "DemoCompany2026!";
const DEMO_FREELANCER_EMAIL = "alex.rivera@freelancer-demo.consultai.local";
const DEMO_FREELANCER_PASSWORD = "DemoFreelancer2026!";

function loginReq(email: string, password: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

function setCookiesOf(res: Response): string[] {
  return (
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    []
  );
}

function sessionCookieOf(res: Response): string {
  const found = setCookiesOf(res).find((c) =>
    c.startsWith("consultai_session_v1=")
  );
  if (!found) throw new Error("expected a session cookie");
  return found.split(";")[0];
}

function dbFailure(code?: string): Error {
  const err = new Error(
    code === "42P01" ? 'relation "users" does not exist' : "connection reset"
  ) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

/** Rejects the drizzle select().from().where().limit() chain once. */
function failSelectOnce(err: Error): void {
  selectMock.mockReturnValueOnce({
    from: () => ({
      where: () => ({
        limit: async () => {
          throw err;
        },
      }),
    }),
  });
}

describe("POST /api/auth/login", () => {
  const saved = {
    demo: process.env.DEMO_MODE,
    dbUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    roleSecret: process.env.ROLE_COOKIE_SECRET,
    sessionSecret: process.env.SESSION_COOKIE_SECRET,
  };
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEMO_MODE = "true";
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "test";
    process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.SESSION_COOKIE_SECRET = "fedcba9876543210fedcba9876543210";
    resetAuthStoreForTests();
    resetDemoStore();
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
  });

  it("demo company account logs in with company role + company scope", async () => {
    const res = await loginPOST(loginReq(DEMO_COMPANY_EMAIL, DEMO_COMPANY_PASSWORD));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      redirectTo: string;
      user: { role: string; companyId: string };
    };
    expect(body.redirectTo).toBe("/dashboard");
    expect(body.user.role).toBe("company");
    expect(body.user.companyId).toBe("company-1");
    const cookies = setCookiesOf(res).join(";");
    expect(cookies).toContain("consultai_session_v1=");
    expect(cookies).not.toContain("consultai_role_v1=");
    const session = await getSessionFromCookie(sessionCookieOf(res));
    expect(session?.role).toBe("company");
    expect(session?.companyId).toBe("company-1");
  });

  it("demo freelancer account logs in with freelancer role + handle", async () => {
    const res = await loginPOST(
      loginReq(DEMO_FREELANCER_EMAIL, DEMO_FREELANCER_PASSWORD)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      redirectTo: string;
      user: { role: string; githubHandle: string };
    };
    expect(body.redirectTo).toBe("/freelancer");
    expect(body.user.role).toBe("freelancer");
    const session = await getSessionFromCookie(sessionCookieOf(res));
    expect(session?.role).toBe("freelancer");
    expect(session?.githubHandle).toBe("alexrivera-dev");
  });

  it("registered user can log in (normal sign-in)", async () => {
    const reg = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "company",
          companyName: "Normal Signin Co",
          contactName: "Normal Owner",
          email: "normal-signin@consultai.test",
          password: "SyntheticPass2026!",
          termsAccepted: true,
        }),
      })
    );
    expect(reg.status).toBe(201);
    const res = await loginPOST(
      loginReq("normal-signin@consultai.test", "SyntheticPass2026!")
    );
    expect(res.status).toBe(200);
    const session = await getSessionFromCookie(sessionCookieOf(res));
    expect(session?.role).toBe("company");
    expect(session?.companyId).toMatch(/^company-/);
  });

  it("wrong password → 401 invalid_credentials (no session cookie)", async () => {
    const res = await loginPOST(loginReq(DEMO_COMPANY_EMAIL, "WrongPass2026!"));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_credentials"
    );
    expect(setCookiesOf(res)).toHaveLength(0);
  });

  it("unknown email → 401 invalid_credentials (non-disclosing)", async () => {
    const res = await loginPOST(
      loginReq("nobody-here-1@consultai.test", "Whatever2026!")
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_credentials"
    );
  });

  it("database failure during lookup → 503 auth_unavailable (never 401)", async () => {
    process.env.DEMO_MODE = "false";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    failSelectOnce(dbFailure());
    const res = await loginPOST(
      loginReq("nobody-here-2@consultai.test", "Whatever2026!")
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("auth_unavailable");
    expect(typeof body.requestId).toBe("string");
  });

  it("missing auth table (42P01) → 503 auth_service_misconfigured", async () => {
    process.env.DEMO_MODE = "false";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    failSelectOnce(dbFailure("42P01"));
    const res = await loginPOST(
      loginReq("nobody-here-3@consultai.test", "Whatever2026!")
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("auth_service_misconfigured");
    expect(typeof body.requestId).toBe("string");
  });

  it("drizzle-wrapped missing table (cause.code 42P01) → 503 auth_service_misconfigured", async () => {
    process.env.DEMO_MODE = "false";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    // Real drizzle-orm/neon-http shape: drizzle wraps the NeonDbError, so
    // the Postgres code lives on `.cause`, not top-level. Losing it here
    // misreports a missing migration as a transient outage (auth_unavailable).
    const driverErr = dbFailure("42P01");
    const drizzleErr = new Error(
      'Failed query: select "id" from "users" where "users"."email" = $1 limit $2\nparams: nobody-here-4@consultai.test,1'
    ) as Error & { cause?: unknown };
    drizzleErr.cause = driverErr;
    failSelectOnce(drizzleErr);
    const res = await loginPOST(
      loginReq("nobody-here-4@consultai.test", "Whatever2026!")
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("auth_service_misconfigured");
    expect(typeof body.requestId).toBe("string");
  });

  it("production-live never auto-seeds demo users (demo email → honest 401)", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEMO_MODE = "false";
    delete process.env.DATABASE_URL;
    const res = await loginPOST(loginReq(DEMO_COMPANY_EMAIL, DEMO_COMPANY_PASSWORD));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_credentials"
    );
  });

  it("production demo-mode still seeds demo users", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEMO_MODE = "true";
    const res = await loginPOST(loginReq(DEMO_COMPANY_EMAIL, DEMO_COMPANY_PASSWORD));
    expect(res.status).toBe(200);
  });

  it("missing session secret falls back without failing login (non-prod)", async () => {
    delete process.env.SESSION_COOKIE_SECRET;
    delete process.env.ROLE_COOKIE_SECRET;
    const res = await loginPOST(loginReq(DEMO_COMPANY_EMAIL, DEMO_COMPANY_PASSWORD));
    expect(res.status).toBe(200);
    const session = await getSessionFromCookie(sessionCookieOf(res));
    expect(session?.companyId).toBe("company-1");
  });

  it("logout revokes the session; login works again after", async () => {
    const first = await loginPOST(
      loginReq(DEMO_COMPANY_EMAIL, DEMO_COMPANY_PASSWORD)
    );
    expect(first.status).toBe(200);
    const cookie = sessionCookieOf(first);
    expect(await getSessionFromCookie(cookie)).not.toBeNull();

    const out = await logoutPOST(
      new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: { cookie },
      })
    );
    expect(out.status).toBe(200);
    expect(await getSessionFromCookie(cookie)).toBeNull();

    const second = await loginPOST(
      loginReq(DEMO_COMPANY_EMAIL, DEMO_COMPANY_PASSWORD)
    );
    expect(second.status).toBe(200);
    expect(await getSessionFromCookie(sessionCookieOf(second))).not.toBeNull();
  });

  it("demo company session is company-scoped (other-company project → 403)", async () => {
    const login = await loginPOST(
      loginReq(DEMO_COMPANY_EMAIL, DEMO_COMPANY_PASSWORD)
    );
    expect(login.status).toBe(200);
    const cookie = sessionCookieOf(login);

    const tables = getDemoTables();
    const foreign = tables.projects.find(
      (p) => p.companyId !== null && p.companyId !== "company-1"
    );
    expect(foreign).toBeDefined();
    const denied = await executionsGET(
      new NextRequest(
        `http://localhost:3000/api/ai-ops/executions?projectId=${foreign!.id}`,
        { headers: { cookie } }
      )
    );
    expect(denied.status).toBe(403);

    const own = await executionsGET(
      new NextRequest("http://localhost:3000/api/ai-ops/executions", {
        headers: { cookie },
      })
    );
    expect(own.status).toBe(200);
  });
});
