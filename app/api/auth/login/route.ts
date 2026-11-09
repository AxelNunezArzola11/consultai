/**
 * POST /api/auth/login
 *
 * Authenticates an existing Company, Freelancer, or Admin user by email & password.
 * - Enforces brute-force lockout protection (`authenticateUser`).
 * - Uses constant-time verification and generic error messages to prevent
 *   account enumeration (`invalid_credentials`).
 * - Issues the signed HttpOnly session cookie (`consultai_session_v1`) only.
 * - Returns role-specific `redirectTo` (`/dashboard`, `/freelancer`, or `/admin`).
 * - Database failures surface as 503 (`auth_unavailable`, or
 *   `auth_service_misconfigured` when the auth schema is missing) with a
 *   `requestId` for server-log correlation — never as 401.
 */

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateUser,
  authServiceErrorCode,
  checkRateLimit,
  createSessionCookie,
  DatabaseUnavailableError,
  isStrictSessionPersistence,
  logAuthServiceFailure,
  verifyCsrfOrigin,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Correlation id for 503 diagnostics (safe to return: random, no PII).
  const requestId = randomUUID();
  if (!verifyCsrfOrigin(req)) {
    return NextResponse.json(
      {
        error: "csrf_origin_mismatch",
        message: "Cross-origin sign-in requests are not permitted.",
      },
      { status: 403 }
    );
  }

  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  const rl = checkRateLimit(`login-ip:${clientIp}`, 25, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `Too many sign-in attempts from this network. Please try again in ${rl.retryAfterSec} seconds.`,
        retryAfterSec: rl.retryAfterSec,
      },
      { status: 429 }
    );
  }

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json(
      {
        error: "missing_credentials",
        message: "Email and password are required.",
      },
      { status: 400 }
    );
  }

  let result: Awaited<ReturnType<typeof authenticateUser>>;
  try {
    result = await authenticateUser(email, password);
  } catch (err) {
    // The credential lookup itself failed (database down, table missing).
    // This is a service failure, not "invalid credentials".
    const dbCode =
      err instanceof DatabaseUnavailableError ? err.dbCode : null;
    logAuthServiceFailure("login", requestId, "user_lookup_failed", dbCode);
    const error = authServiceErrorCode(dbCode);
    return NextResponse.json(
      {
        error,
        message:
          error === "auth_service_misconfigured"
            ? "Sign-in is not available on this deployment yet (server setup incomplete)."
            : "Sign-in is temporarily unavailable. Please try again in a moment.",
        requestId,
      },
      { status: 503 }
    );
  }

  if (result.error === "account_locked") {
    return NextResponse.json(
      {
        error: "account_locked",
        message: `Too many failed sign-in attempts. Please try again in ${result.retryAfterSec ?? 600} seconds.`,
        retryAfterSec: result.retryAfterSec ?? 600,
      },
      { status: 429 }
    );
  }

  if (result.error || !result.user) {
    return NextResponse.json(
      {
        error: "invalid_credentials",
        message: "Invalid email or password.",
      },
      { status: 401 }
    );
  }

  const { sessionCookie, session, dbPersisted, dbErrorCode } =
    await createSessionCookie(result.user);
  if (isStrictSessionPersistence() && !dbPersisted) {
    logAuthServiceFailure(
      "login",
      requestId,
      "session_persist_failed",
      dbErrorCode
    );
    const error = authServiceErrorCode(dbErrorCode);
    return NextResponse.json(
      {
        error,
        message:
          error === "auth_service_misconfigured"
            ? "Sign-in is not available on this deployment yet (server setup incomplete)."
            : "Sign-in is temporarily unavailable. Please try again in a moment.",
        requestId,
      },
      { status: 503 }
    );
  }
  // Session cookie only: consultai_role_v1 is minted exclusively by
  // /api/auth/set-role (demo/dev walkthroughs). Issuing it here would hand
  // every login a session-less company credential that bypasses ownership
  // scoping when the session cookie is stripped (D.3).

  const redirectTo =
    result.user.role === "freelancer"
      ? "/freelancer"
      : result.user.role === "admin"
        ? "/admin"
        : "/dashboard";

  const res = NextResponse.json(
    {
      ok: true,
      user: {
        id: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
        companyId: session.companyId,
        companyName: session.companyName,
        githubHandle: session.githubHandle,
      },
      redirectTo,
    },
    { status: 200 }
  );

  res.headers.append("Set-Cookie", sessionCookie);
  return res;
}
