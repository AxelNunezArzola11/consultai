/**
 * PUT /api/agent/vetting/consent
 * Records candidate consent for vetting.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { candidates, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";

export async function PUT(request: NextRequest) {
  const cookieHeader = request.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: recording vetting consent requires the company or admin role." },
      { status: 403 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(request);
  const { ok, retryAfterSec } = checkRateLimit("vetting-consent", ip, 30, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: { candidateId?: string; projectId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { candidateId, projectId } = body;
  if (!candidateId || typeof candidateId !== "string" || candidateId.length > 100 ||
      !projectId || typeof projectId !== "string" || projectId.length > 100) {
    return NextResponse.json(
      { error: "candidateId and projectId are required" },
      { status: 400 }
    );
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const candidate = t.candidates.find(
      (c) => c.id === candidateId && c.projectId === projectId
    );
    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId) {
      const demoProject = t.projects.find((p) => p.id === projectId);
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    candidate.vettingConsentAt = new Date();
    candidate.updatedAt = new Date();
    return NextResponse.json({
      ok: true,
      consentAt: candidate.vettingConsentAt.toISOString(),
      simulated: true,
    });
  }

  const [candidate] = await db
    .select()
    .from(candidates)
    .where(
      and(eq(candidates.id, candidateId), eq(candidates.projectId, projectId))
    );

  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  if (session?.role === "company" && session.companyId) {
    const [project] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  await db
    .update(candidates)
    .set({ vettingConsentAt: new Date(), updatedAt: new Date() })
    .where(eq(candidates.id, candidateId));

  return NextResponse.json({ ok: true, consentAt: new Date().toISOString() });
}
