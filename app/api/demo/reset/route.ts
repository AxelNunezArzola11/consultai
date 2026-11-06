/**
 * POST /api/demo/reset
 *
 * Restores pristine offline-demo fixtures. Only affects the isolated
 * in-memory demo store — never touches any database.
 *
 * Only meaningful (and only available) when DEMO_MODE=true.
 * Server-side authorization: company or admin role only.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isDemoMode()) {
    return NextResponse.json(
      { error: "demo_reset_requires_demo_mode" },
      { status: 403 }
    );
  }

  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: demo reset requires the company or admin role." },
      { status: 403 }
    );
  }

  const { resetDemoStore, appendDemoAudit } = await import("@/lib/demo/store");
  resetDemoStore();
  appendDemoAudit({
    entityType: "project",
    entityId: "demo-project-saas",
    event: "DEMO_RESET",
    actor: `${role}-operator`,
    payload: {},
  });

  return NextResponse.json({ ok: true, reset: true, simulated: true });
}
