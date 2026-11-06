/**
 * GET /api/health
 *
 * Public status endpoint (no secrets in the response — booleans only).
 * Reports one of: simulated | connected | degraded | unavailable.
 */

import { NextResponse } from "next/server";
import { getSystemHealth } from "@/lib/demo/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const health = await getSystemHealth();
  const status = health.status === "unavailable" ? 503 : 200;
  return NextResponse.json(health, { status });
}
