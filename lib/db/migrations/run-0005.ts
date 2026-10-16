/**
 * Run the Phase 5 (vetting signals, consent flag, search vector) migration.
 * npx tsx lib/db/migrations/run-0005.ts
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function run() {
  const migrationSql = readFileSync(
    join(__dirname, "0005_phase5_vetting_signals.sql"),
    "utf8"
  );
  console.log("Running migration 0005_phase5_vetting_signals.sql …");
  await db.execute(sql.raw(migrationSql));
  console.log("✅ Migration 0005 complete.");
}

run().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
