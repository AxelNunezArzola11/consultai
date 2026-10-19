/**
 * Run the Step 3 (Gantt scheduling) migration.
 * npx tsx lib/db/migrations/run-0007.ts
 *
 * Adds start_date and version columns to milestones.
 *
 * The Neon HTTP driver does not support multi-statement sql.raw() calls
 * ("cannot insert multiple commands into a prepared statement").
 * We execute each DDL statement separately, which is also safe to re-run
 * because both use ADD COLUMN IF NOT EXISTS.
 */
import "dotenv/config";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const STATEMENTS = [
  // start_date: task start date stored as date-only "YYYY-MM-DD".
  // All UTC conversion happens in the reorder route; never in the client.
  `ALTER TABLE milestones ADD COLUMN IF NOT EXISTS start_date DATE`,

  // version: optimistic concurrency counter.
  // Reorder route uses WHERE version = :expected; 0 rows updated → 409.
  `ALTER TABLE milestones ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0`,
];

async function run() {
  console.log("Running migration 0007_step3_gantt_start_date_version …");
  for (const stmt of STATEMENTS) {
    console.log(`  → ${stmt}`);
    await db.execute(sql.raw(stmt));
  }
  console.log("✅ Migration 0007 complete.");
}

run().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
