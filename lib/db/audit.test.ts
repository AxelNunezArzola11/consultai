/**
 * DB integration tests — Step 1 checkpoint
 *
 * Tests:
 * 1. UPDATE on audit_log is rejected by the DB trigger
 * 2. DELETE on audit_log is rejected by the DB trigger
 *
 * These tests hit the live Neon DB.
 * They require DATABASE_URL in the environment.
 * Run with: DATABASE_URL=... npm test
 */

import { describe, it, expect, afterAll } from "vitest";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
const skip = !url;

// Insert a test row we'll try to UPDATE/DELETE
let testRowId: bigint | null = null;

describe.skipIf(skip)("audit_log append-only trigger (DB integration)", () => {
  const sql = neon(url!);

  afterAll(async () => {
    // Clean up test row we inserted
    if (testRowId !== null) {
      // We cannot DELETE via app — use raw SQL to clean up (this is the test bootstrap, not app code)
      // The trigger is on the app's table; we bypass it in cleanup via a separate client to avoid
      // polluting test state. In production the trigger is always active.
      // For this test, we simply leave the row (it's a test entry with a unique event value).
    }
  });

  it("INSERT succeeds (baseline)", async () => {
    const [row] = await sql`
      INSERT INTO audit_log (entity_type, entity_id, event, actor, payload)
      VALUES ('milestone', 'test-sm-row', 'TEST_TRIGGER_CHECK', 'test-suite', '{"test":true}')
      RETURNING id
    `;
    expect(row.id).toBeDefined();
    testRowId = BigInt(row.id);
  });

  it("UPDATE on audit_log raises exception from trigger", async () => {
    if (testRowId === null) {
      // If insert failed, skip this
      return;
    }
    await expect(
      sql`UPDATE audit_log SET actor = 'modified' WHERE id = ${testRowId}`
    ).rejects.toThrow(/append-only/);
  });

  it("DELETE on audit_log raises exception from trigger", async () => {
    if (testRowId === null) {
      return;
    }
    await expect(
      sql`DELETE FROM audit_log WHERE id = ${testRowId}`
    ).rejects.toThrow(/append-only/);
  });
});

