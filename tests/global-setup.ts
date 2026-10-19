/**
 * tests/global-setup.ts
 *
 * Playwright global setup — runs once before all tests.
 *
 * Responsibilities:
 * 1. Guard: refuse if TEST_DATABASE_URL === DATABASE_URL (prevents trashing production data).
 * 2. Start the PayPal mock server (stubs server-to-PayPal HTTP calls).
 * 3. Export a teardown function that stops the mock server.
 *
 * Env vars consumed here (must be set in .env.test or CI):
 *   TEST_DATABASE_URL   — test DB; MUST differ from DATABASE_URL
 *   DATABASE_URL        — production DB (read only for the guard check)
 *   ROLE_COOKIE_SECRET  — ≥32-char secret for signed role cookies
 *   PAYPAL_BASE_URL     — overridden to http://localhost:18080 by this setup
 *   PAYPAL_CLIENT_ID    — any string (mock ignores credentials)
 *   PAYPAL_CLIENT_SECRET— any string (mock ignores credentials)
 *   PAYPAL_ENV          — set to "sandbox" (mock never hits real PayPal)
 */

import { startPaypalMockServer, stopPaypalMockServer, PAYPAL_MOCK_PORT } from "./paypal-mock-server";

export default async function globalSetup() {
  // ── Guard: never run against the production database ─────────────────────
  const testDb  = process.env.TEST_DATABASE_URL;
  const prodDb  = process.env.DATABASE_URL;

  if (!testDb) {
    throw new Error(
      "TEST_DATABASE_URL is not set.\n" +
      "Create consultai/.env.test with a dedicated test database URL.\n" +
      "Refusing to run Playwright tests without a test database."
    );
  }

  if (testDb === prodDb) {
    // Allow an explicit override for single-DB environments (e.g. hackathon with one Neon DB).
    // In production CI, never set this — always use a separate test DB branch.
    const allowSameDb = process.env.ALLOW_PRODUCTION_DB_FOR_TESTS === "true";
    if (!allowSameDb) {
      throw new Error(
        "TEST_DATABASE_URL === DATABASE_URL — this would run tests against the production database.\n" +
        "Set TEST_DATABASE_URL to a separate test database in consultai/.env.test.\n" +
        "To explicitly allow this in a single-DB environment (e.g. local dev / hackathon),\n" +
        "set ALLOW_PRODUCTION_DB_FOR_TESTS=true in .env.test. NEVER set this in CI.\n" +
        "Aborting for safety."
      );
    }
    console.warn(
      "[global-setup] WARNING: TEST_DATABASE_URL === DATABASE_URL and " +
      "ALLOW_PRODUCTION_DB_FOR_TESTS=true is set.\n" +
      "Tests are running against the same database as production.\n" +
      "This is only acceptable in single-DB dev/hackathon environments."
    );
  }

  // Point DATABASE_URL at the test database for all subsequent route handlers
  // (Next.js dev server inherits this env; the production build reads process.env at runtime)
  process.env.DATABASE_URL = testDb;

  // ── PayPal mock server ────────────────────────────────────────────────────
  // Override the PayPal base URL so lib/paypal/client.ts routes all calls
  // to our in-process mock instead of the real PayPal sandbox.
  process.env.PAYPAL_BASE_URL     = `http://localhost:${PAYPAL_MOCK_PORT}`;
  process.env.PAYPAL_ENV          = "sandbox";
  // Mock credentials — the mock server ignores them, but the client requires them to be set
  process.env.PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID     ?? "MOCK_CLIENT_ID";
  process.env.PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ?? "MOCK_CLIENT_SECRET";

  await startPaypalMockServer();
  console.log(`[global-setup] PayPal mock server started on port ${PAYPAL_MOCK_PORT}`);
  console.log(`[global-setup] TEST_DATABASE_URL set (differs from DATABASE_URL ✓)`);

  // Return teardown function — Playwright calls this after all tests complete
  return async function globalTeardown() {
    await stopPaypalMockServer();
    console.log("[global-teardown] PayPal mock server stopped");
  };
}
