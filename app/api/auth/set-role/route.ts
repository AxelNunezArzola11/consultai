/**
 * POST /api/auth/set-role
 *
 * Sets the signed, httpOnly role cookie (`consultai_role_v1`).
 * Body: { role: "company" | "freelancer" | "admin" }
 *
 * SECURITY RULE (Section 3.1 / 3.7):
 * Unauthenticated role-switching via `/api/auth/set-role` is restricted to
 * DEMO mode (`DEMO_MODE=true`) or automated development/test environments.
 * In production LIVE mode (`NODE_ENV === "production"` and `DEMO_MODE !== "true"`),
 * users must authenticate via `/api/auth/login` or `/api/auth/register`.
 */

import { NextRequest, NextResponse } from "next/server";
import { signRoleCookie, type Role } from "@/lib/auth/role-cookie";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

const VALID_ROLES: Role[] = ["company", "freelancer", "admin"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Block unauthenticated role-switching in production LIVE mode
    if (process.env.NODE_ENV === "production" && !isDemoMode()) {
      return NextResponse.json(
        {
          error: "demo_role_switch_disabled",
          message:
            "Role switching is only available in DEMO mode. Please sign in at /login.",
        },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => null);
    const role = body?.role as string | undefined;

    if (!role || !VALID_ROLES.includes(role as Role)) {
      return NextResponse.json(
        { error: `role must be one of: ${VALID_ROLES.join(", ")}` },
        { status: 400 }
      );
    }

    const cookieHeader = await signRoleCookie(role as Role);

    return NextResponse.json(
      { ok: true, role },
      {
        status: 200,
        headers: { "Set-Cookie": cookieHeader },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
