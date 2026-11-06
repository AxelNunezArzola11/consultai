/**
 * playwright.demo.config.ts
 *
 * Demo-mode browser smoke test: production build (`next start`) with
 * DEMO_MODE=true — zero external services. Run:
 *   npm run build && npx playwright test -c playwright.demo.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "demo-smoke.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: process.env.DEMO_BASE_URL ?? "http://localhost:3103",
    trace: "retain-on-failure",
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx next start --port 3103",
    url: "http://localhost:3103",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DEMO_MODE: "true",
      NODE_ENV: "production",
      ROLE_COOKIE_SECRET:
        "demo-smoke-secret-0123456789abcdef-demo-smoke-secret",
      NODE_OPTIONS: "--require /tmp/net-shim.js",
    },
  },
});
