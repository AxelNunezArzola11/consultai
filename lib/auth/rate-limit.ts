/**
 * In-memory rate limiter for API routes.
 *
 * NOTE: This is per-process. Vercel serverless cold starts create new processes,
 * so limits reset. This is adequate for the demo (prevents burst replay attacks
 * within a single warm instance) but is NOT production-grade.
 * Production upgrade: use Upstash Redis INCR with TTL.
 *
 * Usage:
 *   const { ok, retryAfterSec } = checkRateLimit("payout", ip, 10, 60);
 *   if (!ok) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": String(retryAfterSec) } });
 */

interface Bucket {
  count: number;
  windowStart: number; // ms
}

// key = `${namespace}:${ip}`
const store = new Map<string, Bucket>();

/**
 * Checks and updates the rate limit for a given namespace + ip.
 *
 * @param namespace  Route identifier, e.g. "payout"
 * @param ip         Requester IP
 * @param maxCount   Max requests per window
 * @param windowSec  Window size in seconds
 * @returns { ok: boolean; retryAfterSec: number }
 */
export function checkRateLimit(
  namespace: string,
  ip: string,
  maxCount: number,
  windowSec: number
): { ok: boolean; retryAfterSec: number } {
  const key = `${namespace}:${ip}`;
  const now = Date.now();
  const windowMs = windowSec * 1000;

  const bucket = store.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    // New window
    store.set(key, { count: 1, windowStart: now });
    return { ok: true, retryAfterSec: 0 };
  }

  bucket.count += 1;
  if (bucket.count > maxCount) {
    const retryAfterSec = Math.ceil(
      (bucket.windowStart + windowMs - now) / 1000
    );
    return { ok: false, retryAfterSec };
  }

  return { ok: true, retryAfterSec: 0 };
}

/**
 * Returns the requester IP from the Next.js request.
 * Prefers x-forwarded-for (set by Vercel/proxies).
 * Falls back to "unknown".
 */
export function getIp(req: { headers: { get(k: string): string | null } }): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}
