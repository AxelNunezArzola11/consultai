/**
 * playwright.config.ts
 *
 * Playwright configuration for ConsultAI E2E tests.
 *
 * Key decisions:
 * - Chromium only (lightweight; cross-browser is not in scope for this checkpoint)
 * - Production build (`next build --webpack && next start`) — tests run against compiled output
 * - globalSetup starts the PayPal mock server and enforces the DB guard
 * - TEST_DATABASE_URL guard is enforced in global-setup.ts (throws before any test runs)
 * - baseURL from env so CI can point to a deployed instance or local server
 *
 * Run command:
 *   cd consultai && npx playwright test --project=chromium
 */

import { defineConfig, devices } from "@playwright/test";
import * as path from "path";

// Load .env.test if present (local development)
// In CI, env vars come from the CI environment directly.
const envFile = path.resolve(__dirname, ".env.test");

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // Keep serial — tests share a mock server and test DB
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",

  globalSetup: "./tests/global-setup.ts",

  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3001",
    trace: "retain-on-failure",
    // Headless by default; set HEADED=1 for local debugging
    headless: process.env.HEADED !== "1",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Start a production build of Next.js before the tests.
  // The build must already exist (run `npm run build` first).
  // We only start the server here — build is a prerequisite step.
  webServer: {
    //command: "npx dotenv -e .env.test -- next start --port 3001",
    command:"npx dotenv run -f .env.test -- next start --port 3001",
    url: "http://localhost:3001",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Ensure the test database is used by the Next.js server
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      PAYPAL_BASE_URL: `http://localhost:${process.env.PAYPAL_MOCK_PORT ?? 18080}`,
      PAYPAL_ENV: "sandbox",
      PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID ?? "MOCK_CLIENT_ID",
      PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET ?? "MOCK_CLIENT_SECRET",
      ROLE_COOKIE_SECRET: process.env.ROLE_COOKIE_SECRET ?? "",
      // Disable LLM so payment-chat returns 503 deterministically
      GROQ_API_KEY: "",
      NODE_ENV: "production",
    },
  },
});
