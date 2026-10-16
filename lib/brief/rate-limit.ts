/**
 * BriefAgent — per-session rate limiter.
 *
 * Uses the brief_rate_limit table (Phase 3 migration).
 * Window: rolling 1-hour. Limit: BRIEF_LIMITS.SESSION_RATE_LIMIT calls.
 *
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */

import { db } from "@/lib/db";
import { briefRateLimit } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { BRIEF_LIMITS } from "@/lib/brief/schema";

const WINDOW_MS = 60 * 60 * 1_000; // 1 hour

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  callCount?: number;
}

export async function checkBriefRateLimit(
  agentSessionId: string
): Promise<RateLimitResult> {
  const rows = await db
    .select()
    .from(briefRateLimit)
    .where(eq(briefRateLimit.agentSessionId, agentSessionId))
    .limit(1);

  if (rows.length === 0) {
    // First call — insert row
    await db.insert(briefRateLimit).values({
      agentSessionId,
      callCount: 1,
      windowStart: new Date(),
    });
    return { allowed: true, callCount: 1 };
  }

  const row = rows[0];
  const windowAge = Date.now() - row.windowStart.getTime();

  if (windowAge > WINDOW_MS) {
    // Window expired — reset
    await db
      .update(briefRateLimit)
      .set({ callCount: 1, windowStart: new Date() })
      .where(eq(briefRateLimit.agentSessionId, agentSessionId));
    return { allowed: true, callCount: 1 };
  }

  if (row.callCount >= BRIEF_LIMITS.SESSION_RATE_LIMIT) {
    const retryAfterMs = WINDOW_MS - windowAge;
    return { allowed: false, retryAfterMs };
  }

  // Increment
  await db
    .update(briefRateLimit)
    .set({ callCount: row.callCount + 1 })
    .where(eq(briefRateLimit.agentSessionId, agentSessionId));

  return { allowed: true, callCount: row.callCount + 1 };
}
