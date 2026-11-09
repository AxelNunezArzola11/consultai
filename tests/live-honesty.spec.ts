/**
 * Live-mode failure-honesty test (tests/live-honesty.spec.ts).
 *
 * Runs the production build with NO demo mode and NO credentials. The system
 * must distinguish "unavailable" from healthy: /api/health reports
 * unavailable, authenticated contexts see degraded banners / honest 503s
 * instead of silently empty data, and the auth gate contract holds:
 * anonymous -> redirect /login, wrong role -> role home, role-less API
 * callers -> 403.
 *
 * Auth mechanism: signs a role JWT directly in the test (same HS256 shape
 * as lib/auth/role-cookie.ts, mirroring tests/approval.spec.ts). The secret
 * MUST match the live server's ROLE_COOKIE_SECRET
 * (playwright.live.config.ts webServer env); an env override wins when set.
 *
 * Session requirement (D.3): in live mode a company role JWT alone
 * authorizes nothing — company pages redirect to /login and company APIs
 * answer 403 without a verified session. Admin keeps its explicit global
 * contract, so honest-degradation coverage (503s/banners without a
 * database) runs under the admin JWT.
 */

import { test, expect, type Browser } from "@playwright/test";
import * as crypto from "crypto";

const ROLE_COOKIE_NAME = "consultai_role_v1";
// Must match playwright.live.config.ts webServer env (48 chars, >= 32).
const LIVE_ROLE_COOKIE_SECRET =
  process.env.ROLE_COOKIE_SECRET ??
  "live-honesty-secret-0123456789abcdef-live-honesty";

type LiveRole = "company" | "freelancer" | "admin";

async function makeRoleCookieValue(role: LiveRole): Promise<string> {
  const secret = LIVE_ROLE_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ROLE_COOKIE_SECRET must be set (≥32 chars) for live-honesty auth");
  }
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ role, iat: now, exp: now + 86400 })
  ).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sigInput));
  const sig = Buffer.from(sigBytes).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function newAuthedContext(browser: Browser, role: LiveRole) {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: ROLE_COOKIE_NAME,
      value: await makeRoleCookieValue(role),
      domain: "localhost",
      path: "/",
    },
  ]);
  return context;
}

test("health endpoint reports unavailable without credentials", async ({ request }) => {
  const resp = await request.get("/api/health");
  expect(resp.status()).toBe(503);
  const body = await resp.json();
  expect(body.status).toBe("unavailable");
  expect(body.mode).toBe("LIVE");
  expect(body.checks.database).toMatch(/missing_config|error|timeout/);
});

test.describe("anonymous context (no cookies) — redirect contract", () => {
  test("dashboard redirects to /login", async ({ page }) => {
    const resp = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    expect(resp?.status()).toBeLessThan(500);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Sign in to your ConsultAI workspace")).toBeVisible();
  });

  test("ai-ops redirects to /login", async ({ page }) => {
    const resp = await page.goto("/ai-ops", { waitUntil: "domcontentloaded" });
    expect(resp?.status()).toBeLessThan(500);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Sign in to your ConsultAI workspace")).toBeVisible();
  });

  test("operations API returns 403 (role gate precedes queries)", async ({ request }) => {
    const resp = await request.get("/api/operations/data?tab=tasks");
    expect(resp.status()).toBe(403);
  });

  test("sign-in shows credential error for unknown email (email preserved)", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.locator("#login-email").fill("nobody@consultai.test");
    await page.locator("#login-password").fill("WrongPassword2026!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toContainText(
      "Incorrect email or password"
    );
    await expect(page.locator("#login-email")).toHaveValue("nobody@consultai.test");
  });
});

test.describe("landing in live mode — no role minting", () => {
  test("portal clicks route to sign-in without calling set-role", async ({ page }) => {
    let setRoleCalls = 0;
    await page.route("**/api/auth/set-role", async (route) => {
      setRoleCalls += 1;
      await route.abort();
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByText("Enter Company Dashboard").click();
    await expect(page).toHaveURL(/\/login/);
    expect(setRoleCalls).toBe(0);
  });
});

test.describe("session-less company JWT (no session) — session requirement", () => {
  test("dashboard redirects to /login (role cookie alone authorizes nothing)", async ({ browser }) => {
    const context = await newAuthedContext(browser, "company");
    try {
      const page = await context.newPage();
      const resp = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      expect(resp?.status()).toBeLessThan(500);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByText("Sign in to your ConsultAI workspace")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("operations API returns 403 (session required, no unscoped rows)", async ({ request }) => {
    const token = await makeRoleCookieValue("company");
    const resp = await request.get("/api/operations/data?tab=tasks", {
      headers: { Cookie: `${ROLE_COOKIE_NAME}=${token}` },
    });
    expect(resp.status()).toBe(403);
    const body = await resp.json();
    expect(body.error).toBe("missing_company_context");
  });
});

test.describe("authenticated admin context (session-less role JWT)", () => {
  test("ai-ops shows degraded banner instead of silent empties", async ({ browser }) => {
    // Live session-less company holders are redirected to /login on /ai-ops
    // (no company scope to render); the admin-global view renders and fails
    // honestly with the database down.
    const context = await newAuthedContext(browser, "admin");
    try {
      const page = await context.newPage();
      const resp = await page.goto("/ai-ops", { waitUntil: "domcontentloaded" });
      expect(resp?.status()).toBeLessThan(500);
      await expect(page.getByText("Live AI Ops data unavailable")).toBeVisible({ timeout: 30000 });
    } finally {
      await context.close();
    }
  });

  test("operations API returns honest 503, not empty grids", async ({ request }) => {
    const token = await makeRoleCookieValue("admin");
    const resp = await request.get("/api/operations/data?tab=tasks", {
      headers: { Cookie: `${ROLE_COOKIE_NAME}=${token}` },
    });
    expect(resp.status()).toBe(503);
    const body = await resp.json();
    expect(body.status).toBe("unavailable");
  });
});

test.describe("wrong-role context (freelancer JWT)", () => {
  test("dashboard redirects toward freelancer home (no company data)", async ({ request }) => {
    const token = await makeRoleCookieValue("freelancer");
    const resp = await request.get("/dashboard", {
      headers: { Cookie: `${ROLE_COOKIE_NAME}=${token}` },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect([307, 308]).toContain(resp.status());
    expect(resp.headers()["location"]).toMatch(/\/freelancer/);
  });

  test("operations API returns 403", async ({ request }) => {
    const token = await makeRoleCookieValue("freelancer");
    const resp = await request.get("/api/operations/data?tab=tasks", {
      headers: { Cookie: `${ROLE_COOKIE_NAME}=${token}` },
    });
    expect(resp.status()).toBe(403);
  });
});

test("cross-company session isolation is DB-backed (gated, honestly unexecuted)", async () => {
  test.fixme(
    !process.env.TEST_DATABASE_URL,
    "Unblocks when TEST_DATABASE_URL points at an isolated scratch DB: seed " +
      "companies A+B + a company-A project, mint a company-B session, then expect " +
      "notFound/403 on company-A reads. Role-cookie JWTs carry no companyId and " +
      "must not substitute for a session here."
  );
  throw new Error(
    "cross-company seed harness not implemented: needs TEST_DATABASE_URL + session minting (see fixme note)"
  );
});
