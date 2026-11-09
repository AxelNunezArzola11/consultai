/**
 * Session-less role-cookie unforgability tests (lib/auth/role-cookie).
 *
 * The live role cookie is a short-lived HS256 JWT minted exclusively by
 * /api/auth/set-role, which is blocked in production live mode.
 * Login/register issue session cookies only (D.3 — a login-minted role
 * cookie would become a session-less company credential when the session
 * cookie is stripped). These tests pin that a caller without
 * ROLE_COOKIE_SECRET cannot forge or tamper a live role cookie, that logout
 * clears both cookies, and that login/register never mint a role cookie.
 *
 * No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import {
  signRoleCookie,
  getRoleFromCookie,
  COOKIE_NAME,
} from "./role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as setRolePOST } from "@/app/api/auth/set-role/route";
import { resetAuthStoreForTests } from "./session";
import { resetDemoStore } from "@/lib/demo/store";

const LIVE_SECRET = "live-role-secret-0123456789abcdef-live";
const WRONG_SECRET = "wrong-secret-0123456789abcdef-wrong12";

const savedEnv = {
  nodeEnv: process.env.NODE_ENV,
  demoMode: process.env.DEMO_MODE,
  roleSecret: process.env.ROLE_COOKIE_SECRET,
  sessionSecret: process.env.SESSION_COOKIE_SECRET,
};

function roleHeader(token: string): string {
  return `${COOKIE_NAME}=${token}`;
}

function tamperPayload(token: string): string {
  const [h, p, s] = token.split(".");
  const last = p.slice(-1);
  const flipped = last === "A" ? "B" : "A";
  return `${h}.${p.slice(0, -1)}${flipped}.${s}`;
}

async function forgeJwt(
  payload: Record<string, unknown>,
  secret: string,
  expired = false
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(expired ? nowSec - 7200 : nowSec)
    .setExpirationTime(expired ? nowSec - 3600 : nowSec + 86400)
    .sign(new TextEncoder().encode(secret));
}

function setCookiesOf(res: Response): string[] {
  return res.headers.getSetCookie?.() ?? [];
}

describe("role cookie unforgability (live semantics)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "false";
    process.env.ROLE_COOKIE_SECRET = LIVE_SECRET;
    process.env.SESSION_COOKIE_SECRET =
      "test-session-secret-0123456789abcdef-test12";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  afterEach(() => {
    if (savedEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv.nodeEnv;
    if (savedEnv.demoMode === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = savedEnv.demoMode;
    if (savedEnv.roleSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
    else process.env.ROLE_COOKIE_SECRET = savedEnv.roleSecret;
    if (savedEnv.sessionSecret === undefined) {
      delete process.env.SESSION_COOKIE_SECRET;
    } else {
      process.env.SESSION_COOKIE_SECRET = savedEnv.sessionSecret;
    }
  });

  it("a properly signed live cookie resolves to its role (baseline)", async () => {
    const setCookie = await signRoleCookie("company");
    const token = setCookie.split(";")[0].slice(COOKIE_NAME.length + 1);
    await expect(getRoleFromCookie(roleHeader(token))).resolves.toBe("company");
  });

  it("tampered payload → null", async () => {
    const setCookie = await signRoleCookie("company");
    const token = setCookie.split(";")[0].slice(COOKIE_NAME.length + 1);
    await expect(getRoleFromCookie(roleHeader(tamperPayload(token)))).resolves.toBeNull();
  });

  it("token signed with the wrong secret → null", async () => {
    const forged = await forgeJwt({ role: "admin" }, WRONG_SECRET);
    await expect(getRoleFromCookie(roleHeader(forged))).resolves.toBeNull();
  });

  it("unsigned (alg=none) token → null", async () => {
    const b64 = (v: string) =>
      Buffer.from(v).toString("base64url");
    const forged = `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify({ role: "admin" }))}.`;
    await expect(getRoleFromCookie(roleHeader(forged))).resolves.toBeNull();
  });

  it("valid signature but unknown role value → null", async () => {
    const forged = await forgeJwt({ role: "superuser" }, LIVE_SECRET);
    await expect(getRoleFromCookie(roleHeader(forged))).resolves.toBeNull();
  });

  it("expired live token → null", async () => {
    const forged = await forgeJwt({ role: "company" }, LIVE_SECRET, true);
    await expect(getRoleFromCookie(roleHeader(forged))).resolves.toBeNull();
  });

  it("live mode without ROLE_COOKIE_SECRET cannot mint or accept role cookies", async () => {
    delete process.env.ROLE_COOKIE_SECRET;
    await expect(signRoleCookie("company")).rejects.toThrow(
      "ROLE_COOKIE_SECRET must be set"
    );
    // Even a correctly-shaped token is unusable: verification has no secret.
    const forged = await forgeJwt({ role: "company" }, LIVE_SECRET);
    await expect(getRoleFromCookie(roleHeader(forged))).resolves.toBeNull();
  });

  it("live cookie carries httpOnly + SameSite=Strict, and Secure in production", async () => {
    process.env.NODE_ENV = "production";
    const prodCookie = await signRoleCookie("company");
    expect(prodCookie).toContain("HttpOnly");
    expect(prodCookie).toContain("SameSite=Strict");
    expect(prodCookie).toContain("Secure");

    process.env.NODE_ENV = "test";
    const devCookie = await signRoleCookie("company");
    expect(devCookie).toContain("HttpOnly");
    expect(devCookie).toContain("SameSite=Strict");
    expect(devCookie).not.toContain("Secure");
  });

  it("set-role is blocked in production live mode, open in demo mode", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEMO_MODE = "false";
    const blocked = await setRolePOST(
      new NextRequest("http://localhost:3000/api/auth/set-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      })
    );
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error: string };
    expect(blockedBody.error).toBe("demo_role_switch_disabled");

    process.env.DEMO_MODE = "true";
    const allowed = await setRolePOST(
      new NextRequest("http://localhost:3000/api/auth/set-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "company" }),
      })
    );
    expect(allowed.status).toBe(200);
    expect(setCookiesOf(allowed).join(";")).toContain(`${COOKIE_NAME}=`);
  });

  it("register and login mint a session cookie only (never a role cookie)", async () => {
    process.env.DEMO_MODE = "true";
    const reg = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "company",
          companyName: "Pair Mint Co",
          contactName: "Synthetic Owner",
          email: "pair-mint@consultai.test",
          password: "SyntheticPass2026!",
          termsAccepted: true,
        }),
      })
    );
    expect(reg.status).toBe(201);
    const regCookies = setCookiesOf(reg);
    expect(regCookies).toHaveLength(1);
    expect(regCookies.join(";")).toContain("consultai_session_v1=");
    expect(regCookies.join(";")).not.toContain(`${COOKIE_NAME}=`);

    const login = await loginPOST(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "pair-mint@consultai.test",
          password: "SyntheticPass2026!",
        }),
      })
    );
    expect(login.status).toBe(200);
    const loginCookies = setCookiesOf(login);
    expect(loginCookies).toHaveLength(1);
    expect(loginCookies.join(";")).toContain("consultai_session_v1=");
    expect(loginCookies.join(";")).not.toContain(`${COOKIE_NAME}=`);
  });

  it("logout clears both the session and the role cookie", async () => {
    process.env.DEMO_MODE = "true";
    const reg = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "freelancer",
          fullName: "Synthetic Dev",
          email: "pair-logout@consultai.test",
          specialty: "Backend Engineer",
          password: "SyntheticPass2026!",
          termsAccepted: true,
        }),
      })
    );
    expect(reg.status).toBe(201);
    const cookies = setCookiesOf(reg)
      .map((c) => c.split(";")[0])
      .join("; ");

    const out = await logoutPOST(
      new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: { cookie: cookies },
      })
    );
    expect(out.status).toBe(200);
    const clears = setCookiesOf(out);
    const sessionClear = clears.find((c) =>
      c.startsWith("consultai_session_v1=")
    );
    const roleClear = clears.find((c) => c.startsWith(`${COOKIE_NAME}=`));
    expect(sessionClear).toBeDefined();
    expect(roleClear).toBeDefined();
    expect(sessionClear).toContain("Max-Age=0");
    expect(roleClear).toContain("Max-Age=0");
  });
});
