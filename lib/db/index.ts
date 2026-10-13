/**
 * Neon Postgres connection via Drizzle ORM.
 *
 * Uses the serverless driver (@neondatabase/serverless) which is edge-compatible
 * and works in both Node.js runtime and Vercel Edge Functions.
 *
 * DATABASE_URL must be set to the Neon *pooled* connection string for serverless
 * to avoid connection exhaustion. Get it from: https://console.neon.tech
 *
 * IMPORTANT — lazy initialization:
 * The validation and connection are created inside getDb() rather than at module
 * top-level. This prevents next build from throwing during static analysis when
 * DATABASE_URL is only available at runtime (not in the build environment).
 * Pages that call getDb() must export `export const dynamic = "force-dynamic"`
 * so Next.js does not attempt to statically pre-render them at build time.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type Schema = typeof schema;

let _db: NeonHttpDatabase<Schema> | null = null;

/**
 * Returns the singleton Drizzle DB instance.
 * Throws a clear error if DATABASE_URL is not set (fails at request time,
 * not at build time).
 */
export function getDb(): NeonHttpDatabase<Schema> {
  if (_db) return _db;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. " +
        "Set it to the Neon pooled connection string in .env.local or Vercel env vars."
    );
  }

  const sql = neon(databaseUrl);
  _db = drizzle(sql, { schema });
  return _db;
}

/**
 * Convenience re-export: `db` is a proxy that calls getDb() on first access.
 * This allows `import { db } from "@/lib/db"` to work in server components
 * without changing call sites, while still being lazily initialized.
 */
export const db = new Proxy({} as NeonHttpDatabase<Schema>, {
  get(_target, prop) {
    return Reflect.get(getDb(), prop);
  },
});

export type Db = NeonHttpDatabase<Schema>;
