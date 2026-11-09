/**
 * GET /api/ai-ops/executions
 *
 * Returns real database-backed agent availability, active workflows, execution history,
 * pending approvals, financial proposals, scheduling proposals, and audit logs.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
  getAiOpsDashboardSnapshot,
  ScopedAccessError,
} from "@/lib/ai-ops/orchestrator-engine";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode, DEMO_IDS } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const cookieHeader = req.headers.get("cookie") ?? null;
    const session = await getSessionFromCookie(cookieHeader);
    const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
    if (role !== "company" && role !== "admin") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const ip = getIp(req);
    const { ok, retryAfterSec } = checkRateLimit("ai-ops-executions", ip, 60, 60);
    if (!ok) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
      );
    }

    // Company scope comes only from the verified session. Admin keeps the
    // global view. Session-less company role holders are rejected in live
    // mode; in demo mode they see the fictional TechNova fixtures (parity
    // with the demo role-switcher walkthrough; demo/live isolation holds).
    const scopeCompanyId =
      role === "admin"
        ? null
        : session?.role === "company" && session.companyId
          ? session.companyId
          : isDemoMode()
            ? DEMO_IDS.company
            : null;
    if (role === "company" && scopeCompanyId == null) {
      return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId") ?? undefined;
    if (projectId && role === "company" && scopeCompanyId != null) {
      let ownerCompanyId: string | null | undefined;
      if (isDemoMode()) {
        const { getDemoTables } = await import("@/lib/demo/store");
        ownerCompanyId = getDemoTables().projects.find(
          (p) => p.id === projectId
        )?.companyId;
      } else {
        const [project] = await db
          .select({ companyId: projects.companyId })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        ownerCompanyId = project?.companyId;
      }
      if (!ownerCompanyId || ownerCompanyId !== scopeCompanyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    const snapshot = await getAiOpsDashboardSnapshot({
      projectId,
      scopeCompanyId,
      role,
    });
    return NextResponse.json(snapshot, { status: 200 });
  } catch (err) {
    if (err instanceof ScopedAccessError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/ai-ops/executions] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
