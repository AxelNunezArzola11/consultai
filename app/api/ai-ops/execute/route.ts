/**
 * POST /api/ai-ops/execute
 *
 * Runs the Central Supervisor Agent Multi-Agent Workflow.
 * Protected by RBAC: requires role="company" or role="admin" (or valid actor session).
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { runSupervisorWorkflow } from "@/lib/ai-ops/orchestrator-engine";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: require verified role=company or role=admin cookie ──────────────
  // No body fallback: self-asserted actor_role must never authorize workflows.
  const actorRole = await getRoleFromCookie(req.headers.get("cookie"));
  if (actorRole !== "company" && actorRole !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: Only company and admin operators can trigger Supervisor workflows." },
      { status: 403 }
    );
  }

  // ── Rate limit: 20 workflow runs per IP per 60 s ──────────────────────────
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("ai-ops-execute", ip, 20, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  try {
    const body = await req.json().catch(() => null);

    const userRequest = (body?.user_request ?? body?.userRequest ?? "").trim();
    if (!userRequest || userRequest.length < 2) {
      return NextResponse.json(
        { error: "user_request is required (minimum 2 characters)." },
        { status: 400 }
      );
    }

    const result = await runSupervisorWorkflow({
      userRequest,
      operationType: body?.operation_type ?? body?.operationType ?? "auto",
      projectId: body?.project_id ?? body?.projectId,
      milestoneId: body?.milestone_id ?? body?.milestoneId,
      candidateId: body?.candidate_id ?? body?.candidateId,
      actorRole,
      actorId: body?.actor_id ?? `${actorRole}-operator`,
      context: body?.context ?? {},
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/ai-ops/execute] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
