/**
 * Live-mode failure-honesty test (tests/live-honesty.spec.ts).
 *
 * Runs the production build with NO demo mode and NO credentials. The system
 * must distinguish "unavailable" from healthy: /api/health reports
 * unavailable, and DB-backed pages show the degraded banner instead of
 * silently empty data.
 */

import { test, expect } from "@playwright/test";

test("health endpoint reports unavailable without credentials", async ({ request }) => {
  const resp = await request.get("/api/health");
  expect(resp.status()).toBe(503);
  const body = await resp.json();
  expect(body.status).toBe("unavailable");
  expect(body.mode).toBe("LIVE");
  expect(body.checks.database).toMatch(/missing_config|error|timeout/);
});

test("dashboard shows degraded banner instead of silent empties", async ({ page }) => {
  const resp = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  expect(resp?.status()).toBeLessThan(500);
  await expect(page.getByText("Live data unavailable")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/LIVE MODE/)).toBeVisible();
});

test("ai-ops shows degraded banner instead of silent empties", async ({ page }) => {
  await page.goto("/ai-ops", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Live AI Ops data unavailable")).toBeVisible({ timeout: 30000 });
});

test("operations API returns honest 503, not empty grids", async ({ request }) => {
  const resp = await request.get("/api/operations/data?tab=tasks");
  expect(resp.status()).toBe(503);
  const body = await resp.json();
  expect(body.status).toBe("unavailable");
});
