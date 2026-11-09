/**
 * GET /api/projects/[id]/ledger
 *
 * Returns milestone rows in the shape FinancialLedger expects.
 * Also joins the shortlisted candidate (consultant field) per project if available.
 *
 * Auth: company/admin role required; company sessions are scoped to their
 * own company's projects (cross-company IDs return 403).
 * Rate-limited (poll endpoint).
 * Returns 200 { rows: LedgerRow[] } or 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, milestones, candidates } from "@/lib/db/schema";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "Company financial ledgers require the company or admin role.",
      },
      { status: 403 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("ledger", ip, 120, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  const { id: projectId } = await params;

  if (isDemoMode()) {
    const t = getDemoTables();
    const project = t.projects.find((p) => p.id === projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (
      session?.role === "company" &&
      session.companyId &&
      project.companyId !== session.companyId
    ) {
      return NextResponse.json(
        { error: "forbidden", message: "Project belongs to another company." },
        { status: 403 }
      );
    }
    const rows = t.milestones
      .filter((m) => m.projectId === projectId)
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        budgetUsd: Number(m.budgetUsd),
        captureGrossUsd: m.captureGrossUsd != null ? Number(m.captureGrossUsd) : null,
        captureNetUsd: m.captureNetUsd != null ? Number(m.captureNetUsd) : null,
        captureFeeUsd: m.captureFeeUsd != null ? Number(m.captureFeeUsd) : null,
        dueDate: m.dueDate ?? null,
        consultant: t.candidates.find((c) => c.projectId === projectId)?.name ?? null,
        position: m.position,
      }));
    return NextResponse.json({ rows });
  }

  const [project] = await db
    .select({ id: projects.id, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (
    session?.role === "company" &&
    session.companyId &&
    project.companyId !== session.companyId
  ) {
    return NextResponse.json(
      { error: "forbidden", message: "Project belongs to another company." },
      { status: 403 }
    );
  }

  // Fetch milestones
  const milestoneRows = await db
    .select({
      id: milestones.id,
      title: milestones.title,
      status: milestones.status,
      budgetUsd: milestones.budgetUsd,
      captureGrossUsd: milestones.captureGrossUsd,
      captureNetUsd: milestones.captureNetUsd,
      captureFeeUsd: milestones.captureFeeUsd,
      dueDate: milestones.dueDate,
      position: milestones.position,
    })
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
    .orderBy(milestones.position);

  // Fetch the shortlisted/selected candidate name for the project (if any)
  const [shortlisted] = await db
    .select({ name: candidates.name })
    .from(candidates)
    .where(eq(candidates.projectId, projectId))
    .limit(1);

  const consultantName = shortlisted?.name ?? null;

  const rows = milestoneRows.map((m) => ({
    id: m.id,
    title: m.title,
    status: m.status,
    budgetUsd: Number(m.budgetUsd),
    captureGrossUsd: m.captureGrossUsd != null ? Number(m.captureGrossUsd) : null,
    captureNetUsd: m.captureNetUsd != null ? Number(m.captureNetUsd) : null,
    captureFeeUsd: m.captureFeeUsd != null ? Number(m.captureFeeUsd) : null,
    dueDate: m.dueDate ?? null,
    consultant: consultantName,
    position: m.position,
  }));

  return NextResponse.json({ rows });
}
