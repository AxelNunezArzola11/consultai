/**
 * Provision the two login-page demo accounts as real `users` rows.
 *
 * Run with: npm run provision:demo-users
 *
 * Uses DATABASE_URL from the environment (.env.local for local runs).
 * Idempotent: existing rows are reported as skipped, never overwritten.
 */

// Load .env.local for local runs
import "dotenv/config";

import { provisionDemoUsers } from "./demo-users";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — cannot provision demo users.");
    process.exit(1);
  }
  console.log("Provisioning demo accounts...");
  const result = await provisionDemoUsers();
  for (const u of result.users) {
    console.log(
      `  ${u.email}: ${u.status === "created" ? "created" : "already exists (skipped)"}`
    );
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("Provisioning failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
