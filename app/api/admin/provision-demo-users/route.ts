/**
 * POST /api/admin/provision-demo-users
 *
 * One-shot bootstrap for production live deployments: creates the two demo
 * accounts behind the login page quick-fill buttons
 * (founder@acme-demo.consultai.local, alex.rivera@freelancer-demo.consultai.local)
 * as real `users` rows. Production never auto-seeds, so without this call
 * those credentials return `invalid_credentials`.
 *
 * Security:
 * - Gated by INTERNAL_API_SECRET (x-provision-secret header, timing-safe
 *   compare). Fails closed (503) when the secret is unconfigured.
 * - Creates ONLY the two fixed demo accounts — the request body selects
 *   nothing. Existing rows are never overwritten (reported as skipped).
 * - Rate-limited (5 req / 5 min per IP) and CSRF origin-checked.
 * - Never returns password hashes or the secret.
 */

import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyCsrfOrigin } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { provisionDemoUsers } from "@/lib/seed/demo-users";

export const dynamic = "force-dynamic";

function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCsrfOrigin(req)) {
    return NextResponse.json(
      {
        error: "csrf_origin_mismatch",
        message: "Cross-origin provisioning requests are not permitted.",
      },
      { status: 403 }
    );
  }

  // Rate-limit before the secret check so the secret cannot be brute-forced.
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("provision-demo-users", ip, 5, 300);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  const expected = process.env.INTERNAL_API_SECRET?.trim();
  if (!expected) {
    return NextResponse.json(
      {
        error: "provisioning_unavailable",
        message:
          "Demo provisioning is not configured on this deployment (server setup incomplete).",
      },
      { status: 503 }
    );
  }

  const provided = req.headers.get("x-provision-secret")?.trim() ?? "";
  if (!provided || !secretsMatch(provided, expected)) {
    return NextResponse.json(
      { error: "forbidden", message: "Invalid provisioning secret." },
      { status: 403 }
    );
  }

  try {
    const result = await provisionDemoUsers();
    return NextResponse.json(
      {
        ok: true,
        users: result.users,
        note: "Demo accounts are ready — use the login page quick-fill buttons to sign in.",
      },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      `[provision-demo-users] failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      {
        error: "provisioning_failed",
        message: "Could not provision demo accounts. Check server logs.",
      },
      { status: 500 }
    );
  }
}
