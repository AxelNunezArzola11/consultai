/**
 * Run the Phase 6 (dispute handling) migration.
 * npx tsx lib/db/migrations/run-0006.ts
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function run() {
  const migrationSql = readFileSync(
    join(__dirname, "0006_phase6_disputes.sql"),
    "utf8"
  );
  console.log("Running migration 0006_phase6_disputes.sql …");
  await db.execute(sql.raw(migrationSql));
  console.log("✅ Migration 0006 complete.");
}

run().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
