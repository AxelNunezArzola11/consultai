/**
 * Neon Postgres connection via Drizzle ORM.
 *
 * Uses neon-http (@neondatabase/serverless HTTP driver) which is the correct
 * driver for Vercel serverless Node.js functions.
 *
 * IMPORTANT — neon-http does NOT support .transaction():
 *   Calling db.transaction() throws "No transactions support in neon-http driver".
 *   Use sequential awaited statements instead (leaves-first deletion order).
 *
 * IMPORTANT — lazy initialization:
 *   The DB instance is created inside getDb() rather than at module top-level.
 *   This prevents next build from throwing when DATABASE_URL is only available
 *   at runtime (not in the build environment).
 *   All route files that use `db` must export `export const dynamic = "force-dynamic"`.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type Schema = typeof schema;

let _db: NeonHttpDatabase<Schema> | null = null;

/**
 * Returns the singleton Drizzle DB instance.
 *
 * Throws a descriptive error if DATABASE_URL is not set, ensuring the
 * 500 body contains the real reason rather than a generic crash message.
 *
 * Also logs whether DATABASE_URL is present each time a new instance is
 * created (first request per function instance) so Vercel logs show the
 * state at the exact moment of failure.
 */
export function getDb(): NeonHttpDatabase<Schema> {
  if (_db) return _db;

  const databaseUrl = process.env.DATABASE_URL;

  // Diagnostic log — only on first initialization per instance
  console.log("[lib/db] initializing — DATABASE_URL present:", !!databaseUrl);

  if (!databaseUrl) {
    const err = new Error(
      "DATABASE_URL is not set. " +
        "Configure the Neon pooled connection string in .env.local or " +
        "Vercel → Settings → Environment Variables → Production."
    );
    console.error("[lib/db] DATABASE_URL missing — cannot connect to Neon.");
    throw err;
  }

  // Validate the URL looks like a Postgres connection string
  if (!databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
    const err = new Error(
      `DATABASE_URL does not look like a Postgres URL (starts with "${databaseUrl.slice(0, 15)}..."). ` +
        "Expected postgresql:// or postgres://"
    );
    console.error("[lib/db] DATABASE_URL format invalid");
    throw err;
  }

  const sql = neon(databaseUrl);
  _db = drizzle(sql, { schema });
  return _db;
}

/**
 * Convenience re-export: `db` is a proxy that calls getDb() on first access.
 * This allows `import { db } from "@/lib/db"` to work in server components
 * without changing call sites, while still being lazily initialized.
 *
 * Any error from getDb() propagates to the caller — route handlers must
 * wrap DB calls in try/catch to avoid raw 500s.
 */
export const db = new Proxy({} as NeonHttpDatabase<Schema>, {
  get(_target, prop) {
    return Reflect.get(getDb(), prop);
  },
});

export type Db = NeonHttpDatabase<Schema>;
