/**
 * playwright.live.config.ts
 *
 * Live-mode failure-honesty check: production build WITHOUT demo mode and
 * WITHOUT credentials. The app must report "unavailable" honestly — never
 * silent empty dashboards. Run:
 *   npm run build && npx playwright test -c playwright.live.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "live-honesty.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? "http://localhost:3104",
    trace: "retain-on-failure",
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx next start --port 3104",
    url: "http://localhost:3104",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "production",
      // Explicitly establish the documented preconditions: `next start`
      // loads .env.local, which would otherwise leak DEMO_MODE=true and a
      // real DATABASE_URL into this "live without credentials" check.
      // Explicit process env wins over .env files.
      DEMO_MODE: "false",
      DATABASE_URL: "",
      ROLE_COOKIE_SECRET:
        "live-honesty-secret-0123456789abcdef-live-honesty",
      NODE_OPTIONS: "--require /tmp/net-shim.js",
    },
  },
});
