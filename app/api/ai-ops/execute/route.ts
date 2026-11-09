/**
 * POST /api/ai-ops/execute
 *
 * Runs the Central Supervisor Agent Multi-Agent Workflow.
 * Protected by RBAC: requires role="company" or role="admin" (or valid actor session).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, milestones, candidates } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import {
  runSupervisorWorkflow,
  ScopedAccessError,
  MissingProjectError,
} from "@/lib/ai-ops/orchestrator-engine";
import { isDemoMode, DEMO_IDS } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: require verified role=company or role=admin cookie ──────────────
  // No body fallback: self-asserted actor_role must never authorize workflows.
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const actorRole = session?.role ?? (await getRoleFromCookie(cookieHeader));
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

    const userRequest = String(body?.user_request ?? body?.userRequest ?? "").trim();
    if (!userRequest || userRequest.length < 2) {
      return NextResponse.json(
        { error: "user_request is required (minimum 2 characters)." },
        { status: 400 }
      );
    }
    if (userRequest.length > 4000) {
      return NextResponse.json(
        { error: "user_request exceeds maximum length of 4000 characters." },
        { status: 400 }
      );
    }

    const projectId = body?.project_id ?? body?.projectId;
    const milestoneId = body?.milestone_id ?? body?.milestoneId;
    const candidateId = body?.candidate_id ?? body?.candidateId;
    for (const [name, value] of [["projectId", projectId], ["milestoneId", milestoneId], ["candidateId", candidateId]] as const) {
      if (value !== undefined && value !== null &&
          (typeof value !== "string" || value.length > 100)) {
        return NextResponse.json({ error: `invalid ${name}` }, { status: 400 });
      }
    }

    // Company scope comes only from the verified session. Admin runs
    // global. Session-less company holders are rejected in live mode; in
    // demo mode they run against the fictional TechNova fixtures (parity
    // with the demo role-switcher walkthrough; demo/live isolation holds).
    const scopeCompanyId =
      actorRole === "admin"
        ? null
        : session?.role === "company" && session.companyId
          ? session.companyId
          : isDemoMode()
            ? DEMO_IDS.company
            : null;
    if (actorRole === "company" && scopeCompanyId == null) {
      return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
    }

    // Explicit project required for every run (no global-project fallback).
    if (typeof projectId !== "string" || projectId.length === 0) {
      return NextResponse.json({ error: "missing_project_id" }, { status: 400 });
    }

    // Company scoping: verify the named project against the scope, and
    // verify any supplied milestone/candidate belongs to that project
    // (prevents cross-project id confusion).
    if (actorRole === "company" && scopeCompanyId != null) {
      let ownerCompanyId: string | null | undefined;
      let milestoneProjectId: string | null | undefined;
      let candidateProjectId: string | null | undefined;
      if (isDemoMode()) {
        const { getDemoTables } = await import("@/lib/demo/store");
        const t = getDemoTables();
        ownerCompanyId = t.projects.find((p) => p.id === projectId)?.companyId;
        if (typeof milestoneId === "string") {
          milestoneProjectId =
            t.milestones.find((m) => m.id === milestoneId)?.projectId ?? null;
        }
        if (typeof candidateId === "string") {
          candidateProjectId =
            t.candidates.find((c) => c.id === candidateId)?.projectId ?? null;
        }
      } else {
        const [proj] = await db
          .select({ companyId: projects.companyId })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        ownerCompanyId = proj?.companyId;
        if (typeof milestoneId === "string") {
          const [ms] = await db
            .select({ projectId: milestones.projectId })
            .from(milestones)
            .where(eq(milestones.id, milestoneId))
            .limit(1);
          milestoneProjectId = ms?.projectId ?? null;
        }
        if (typeof candidateId === "string") {
          const [cand] = await db
            .select({ projectId: candidates.projectId })
            .from(candidates)
            .where(eq(candidates.id, candidateId))
            .limit(1);
          candidateProjectId = cand?.projectId ?? null;
        }
      }
      if (!ownerCompanyId || ownerCompanyId !== scopeCompanyId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (
        (typeof milestoneId === "string" && milestoneProjectId !== projectId) ||
        (typeof candidateId === "string" && candidateProjectId !== projectId)
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const result = await runSupervisorWorkflow({
      userRequest,
      operationType: body?.operation_type ?? body?.operationType ?? "auto",
      projectId,
      milestoneId,
      candidateId,
      actorRole,
      actorId: session ? `${session.role}:${session.userId}` : (body?.actor_id ?? `${actorRole}-operator`),
      context: body?.context ?? {},
      scopeCompanyId,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ScopedAccessError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (err instanceof MissingProjectError) {
      return NextResponse.json({ error: "missing_project_id" }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/ai-ops/execute] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
