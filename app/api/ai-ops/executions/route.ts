/**
 * GET /api/ai-ops/executions
 *
 * Returns real database-backed agent availability, active workflows, execution history,
 * pending approvals, financial proposals, scheduling proposals, and audit logs.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAiOpsDashboardSnapshot } from "@/lib/ai-ops/orchestrator-engine";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId") ?? undefined;
    const snapshot = await getAiOpsDashboardSnapshot(projectId);
    return NextResponse.json(snapshot, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/ai-ops/executions] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
