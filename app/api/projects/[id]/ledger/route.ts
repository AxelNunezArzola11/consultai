/**
 * GET /api/projects/[id]/ledger
 *
 * Returns milestone rows in the shape FinancialLedger expects.
 * Also joins the shortlisted candidate (consultant field) per project if available.
 *
 * Auth: no role check — same project-level visibility as the milestones page.
 * Returns 200 { rows: LedgerRow[] } or 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, milestones, candidates } from "@/lib/db/schema";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: projectId } = await params;

  if (isDemoMode()) {
    const t = getDemoTables();
    const project = t.projects.find((p) => p.id === projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
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
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
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
