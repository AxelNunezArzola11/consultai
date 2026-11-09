/**
 * POST /api/auth/logout
 *
 * Invalidates the active session token server-side and clears both
 * `consultai_session_v1` and `consultai_role_v1` cookies.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  revokeSessionFromCookie,
  verifyCsrfOrigin,
} from "@/lib/auth/session";
import { clearRoleCookie } from "@/lib/auth/role-cookie";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCsrfOrigin(req)) {
    return NextResponse.json(
      {
        error: "csrf_origin_mismatch",
        message: "Cross-origin logout requests are not permitted.",
      },
      { status: 403 }
    );
  }

  const clearSession = await revokeSessionFromCookie(req.headers.get("cookie"));
  const clearRole = clearRoleCookie();

  const res = NextResponse.json(
    { ok: true, redirectTo: "/login" },
    { status: 200 }
  );
  res.headers.append("Set-Cookie", clearSession);
  res.headers.append("Set-Cookie", clearRole);
  return res;
}
