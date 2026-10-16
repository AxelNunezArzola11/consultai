/**
 * Run the Phase 4 (NDA gate, scheduling, cascade) migration.
 * npx tsx lib/db/migrations/run-0004.ts
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function run() {
  const migrationSql = readFileSync(
    join(__dirname, "0004_phase4_nda_scheduling.sql"),
    "utf8"
  );
  console.log("Running migration 0004_phase4_nda_scheduling.sql …");
  await db.execute(sql.raw(migrationSql));
  console.log("✅ Migration 0004 complete.");
}

run().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
