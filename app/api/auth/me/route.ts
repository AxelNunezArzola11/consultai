/**
 * GET /api/auth/me
 *
 * Returns the active authenticated session or current demo role context.
 * Never exposes password hashes, cookies, or secrets.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookie } from "@/lib/auth/session";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cookieHeader = req.headers.get("cookie");
  const session = await getSessionFromCookie(cookieHeader);

  if (session) {
    return NextResponse.json({
      authenticated: true,
      demoMode: isDemoMode(),
      user: {
        id: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
        companyId: session.companyId,
        companyName: session.companyName,
        githubHandle: session.githubHandle,
      },
    });
  }

  const role = await getRoleFromCookie(cookieHeader);
  return NextResponse.json({
    authenticated: false,
    demoMode: isDemoMode(),
    role: role ?? null,
    user: null,
  });
}
