/**
 * Run the Phase 3 (BriefAgent) migration.
 * npx tsx lib/db/migrations/run-0003.ts
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function run() {
  const migrationSql = readFileSync(
    join(__dirname, "0003_brief_agent.sql"),
    "utf8"
  );
  console.log("Running migration 0003_brief_agent.sql …");
  await db.execute(sql.raw(migrationSql));
  console.log("✅ Migration 0003 complete.");
}

run().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
