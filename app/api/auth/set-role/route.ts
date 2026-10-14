/**
 * POST /api/auth/set-role
 *
 * Sets the signed, httpOnly role cookie.
 * Body: { role: "company" | "freelancer" }
 *
 * DEMO AUTH — not production auth.
 * See lib/auth/role-cookie.ts for details.
 */

import { NextRequest, NextResponse } from "next/server";
import { signRoleCookie, type Role } from "@/lib/auth/role-cookie";

export const dynamic = "force-dynamic";

const VALID_ROLES: Role[] = ["company", "freelancer"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
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
