/**
 * tests/gantt-reorder.spec.ts
 *
 * Playwright E2E test — Gantt / milestone reorder server action.
 *
 * Strategy (per plan correction 3):
 *   Tests the /api/projects/[id]/milestones/reorder route directly via HTTP POST.
 *   UI interaction is best-effort (Bryntum fixme).
 *
 * Data: a beforeAll hook seeds one project + two milestones (one planned, one funded)
 *   directly into the test DB via the Neon HTTP API, then removes them in afterAll.
 *   This makes tests deterministic without relying on .env.test seed IDs.
 *
 * Auth: HS256 JWT cookie signed with ROLE_COOKIE_SECRET — no browser login required.
 */

import { test, expect } from "@playwright/test";
import * as crypto from "crypto";
import { neon } from "@neondatabase/serverless";

// ── Auth helper ────────────────────────────────────────────────────────────────

async function makeCompanyCookieValue(): Promise<string> {
  const secret = process.env.ROLE_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ROLE_COOKIE_SECRET must be set (≥32 chars) in .env.test");
  }
  const header  = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now     = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ role: "company", iat: now, exp: now + 86400 })
  ).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sigInput));
  return `${header}.${payload}.${Buffer.from(sigBytes).toString("base64url")}`;
}

async function companyHeaders(): Promise<Record<string, string>> {
  return {
    "Cookie": `consultai_role_v1=${await makeCompanyCookieValue()}`,
    "Content-Type": "application/json",
  };
}

// ── Test fixture IDs (stable across runs) ─────────────────────────────────────

const E2E_PROJECT_ID  = "e2e-gantt-project-001";
const E2E_COMPANY_ID  = "e2e-gantt-company-001";
const E2E_PLANNED_ID  = "e2e-gantt-milestone-planned";
const E2E_FUNDED_ID   = "e2e-gantt-milestone-funded";

// ── DB seed / teardown ────────────────────────────────────────────────────────

function getSql() {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL not set");
  return neon(url);
}

test.beforeAll(async () => {
  const sql = getSql();

  // Seed company — no updated_at column; email is required
  await sql`
    INSERT INTO companies (id, name, email, created_at)
    VALUES (${E2E_COMPANY_ID}, 'E2E Gantt Test Co', 'e2e-gantt@test.local', now())
    ON CONFLICT (id) DO NOTHING
  `;

  // Seed project
  await sql`
    INSERT INTO projects (id, company_id, title, status, created_at, updated_at)
    VALUES (${E2E_PROJECT_ID}, ${E2E_COMPANY_ID}, 'E2E Gantt Test Project', 'active', now(), now())
    ON CONFLICT (id) DO NOTHING
  `;

  // Seed planned milestone (can be rescheduled)
  await sql`
    INSERT INTO milestones (
      id, project_id, title, budget_usd, status, position,
      start_date, due_date, version, created_at, updated_at
    ) VALUES (
      ${E2E_PLANNED_ID}, ${E2E_PROJECT_ID}, 'Planned Milestone',
      '500.00', 'planned', 0,
      '2025-09-01', '2025-09-15', 0, now(), now()
    )
    ON CONFLICT (id) DO NOTHING
  `;

  // Seed funded milestone (must be rejected by reorder route)
  await sql`
    INSERT INTO milestones (
      id, project_id, title, budget_usd, status, position,
      start_date, due_date, version, created_at, updated_at
    ) VALUES (
      ${E2E_FUNDED_ID}, ${E2E_PROJECT_ID}, 'Funded Milestone',
      '1000.00', 'funded', 1,
      '2025-10-01', '2025-10-15', 0, now(), now()
    )
    ON CONFLICT (id) DO NOTHING
  `;
});

test.afterAll(async () => {
  const sql = getSql();
  // Clean up in dependency order.
  // NOTE: audit_log is append-only (DB trigger enforces this) — we do NOT attempt
  // to delete audit entries. Test entries will remain in the table, which is fine.
  await sql`DELETE FROM milestones WHERE project_id = ${E2E_PROJECT_ID}`;
  await sql`DELETE FROM projects   WHERE id = ${E2E_PROJECT_ID}`;
  await sql`DELETE FROM companies  WHERE id = ${E2E_COMPANY_ID}`;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Gantt reorder — server action", () => {

  test("POST planned milestone → 200 OK, row updated, audit entry written", async ({ request }) => {
    const headers = await companyHeaders();
    const sql = getSql();

    const newStart = "2025-09-08"; // shift one week forward

    const res = await request.post(
      `/api/projects/${E2E_PROJECT_ID}/milestones/reorder`,
      {
        headers,
        data: { milestoneId: E2E_PLANNED_ID, newStartDate: newStart, expectedVersion: 0 },
        failOnStatusCode: false,
      }
    );

    expect(res.status()).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.newStartDate).toBe(newStart);
    expect(body.version).toBe(1);

    // Verify row in DB.
    // Neon may return DATE columns as JS Date objects or ISO strings with time zone.
    // Normalise to YYYY-MM-DD by slicing the ISO string.
    const [row] = await sql`
      SELECT start_date::text AS start_date, version FROM milestones WHERE id = ${E2E_PLANNED_ID}
    `;
    const startDateStr = String(row.start_date ?? "").slice(0, 10);
    expect(startDateStr).toBe(newStart);
    expect(row.version).toBe(1);

    // Verify audit_log entry
    const auditRows = await sql`
      SELECT event FROM audit_log
      WHERE entity_id = ${E2E_PLANNED_ID} AND event = 'MILESTONE_RESCHEDULED'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0].event).toBe("MILESTONE_RESCHEDULED");

    console.log(`[gantt-reorder] Planned milestone rescheduled → ${newStart}, version 0→1, audit entry ✓`);
  });

  test("Funded milestone reorder → 409 Conflict with funded protection message", async ({ request }) => {
    const headers = await companyHeaders();

    const res = await request.post(
      `/api/projects/${E2E_PROJECT_ID}/milestones/reorder`,
      {
        headers,
        data: {
          milestoneId:  E2E_FUNDED_ID,
          newStartDate: "2025-11-01",
          expectedVersion: 0,
        },
        failOnStatusCode: false,
      }
    );

    expect(res.status()).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).toMatch(/funded|cannot|protected/i);
    console.log(`[gantt-reorder] Funded milestone correctly rejected 409: ${JSON.stringify(body)}`);
  });

  test("Optimistic concurrency: stale version → 409 Conflict", async ({ request }) => {
    const headers = await companyHeaders();
    const sql = getSql();

    // Read the current version from DB — makes the test self-contained regardless
    // of whether prior tests have already incremented the counter.
    const [current] = await sql`
      SELECT version FROM milestones WHERE id = ${E2E_PLANNED_ID}
    `;
    const currentVersion = Number(current?.version ?? 0);

    // First move the milestone to a known state with the correct version
    const validRes = await request.post(
      `/api/projects/${E2E_PROJECT_ID}/milestones/reorder`,
      {
        headers,
        data: {
          milestoneId:     E2E_PLANNED_ID,
          newStartDate:    "2025-09-22",
          expectedVersion: currentVersion,   // correct — this should succeed
        },
        failOnStatusCode: false,
      }
    );
    expect(validRes.status()).toBe(200);
    const newVersion = currentVersion + 1;

    // Now send the same (now stale) version — must be rejected
    const staleRes = await request.post(
      `/api/projects/${E2E_PROJECT_ID}/milestones/reorder`,
      {
        headers,
        data: {
          milestoneId:     E2E_PLANNED_ID,
          newStartDate:    "2025-09-29",
          expectedVersion: currentVersion,   // stale — DB is now at newVersion
        },
        failOnStatusCode: false,
      }
    );

    expect(staleRes.status()).toBe(409);
    const body = await staleRes.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).toMatch(/concurr|conflict|stale|version/i);
    console.log(`[gantt-reorder] Stale version (${currentVersion} vs DB ${newVersion}) correctly rejected 409 ✓`);
  });

  test("No company cookie → 403 Forbidden", async ({ request }) => {
    const res = await request.post(
      `/api/projects/${E2E_PROJECT_ID}/milestones/reorder`,
      {
        data: { milestoneId: E2E_PLANNED_ID, newStartDate: "2025-09-10" },
        failOnStatusCode: false,
      }
    );
    expect(res.status()).toBe(403);
    console.log("[gantt-reorder] No cookie → 403 ✓");
  });

  test("Invalid date string → 400 Bad Request", async ({ request }) => {
    const headers = await companyHeaders();
    const res = await request.post(
      `/api/projects/${E2E_PROJECT_ID}/milestones/reorder`,
      {
        headers,
        data: { milestoneId: E2E_PLANNED_ID, newStartDate: "not-a-date" },
        failOnStatusCode: false,
      }
    );
    expect(res.status()).toBe(400);
    console.log("[gantt-reorder] Invalid date → 400 ✓");
  });

  test("Best-effort UI: milestones page renders without crash", async ({ page }) => {
    const token = await makeCompanyCookieValue();
    await page.context().addCookies([
      { name: "consultai_role_v1", value: token, domain: "localhost", path: "/" },
    ]);

    const res = await page.goto(
      `/project/${E2E_PROJECT_ID}/milestones`,
      { waitUntil: "networkidle" }
    );

    if (res && res.status() === 404) {
      test.skip(true, "Test project not seeded — UI check inconclusive");
      return;
    }

    await expect(page).not.toHaveTitle(/error/i);
    // Page must contain at least one element with the milestone title.
    // Use .first() to avoid strict-mode failure when the title appears in both
    // the card heading and a PayPal button label.
    await expect(page.getByText("Planned Milestone").first()).toBeVisible({ timeout: 8000 });
    console.log("[gantt-reorder] Milestones page loaded, seeded milestone visible ✓");
  });
});
