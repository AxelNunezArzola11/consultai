/**
 * POST /api/projects
 *
 * Creates a draft project row. Called ONLY from explicit user action (the
 * /project/new start form) — never on page load.
 *
 * Body: { projectId: string (client-generated nanoid), title?: string, brief?: string }
 * Returns: { projectId, created: boolean }
 *
 * Idempotency: the client generates the project ID once per form instance, so
 * retries and double-submits resolve to the same row (onConflictDoNothing).
 *
 * Server-side authorization: company or admin role only.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { writeAuditLog } from "@/lib/db/audit";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: creating projects requires the company or admin role." },
      { status: 403 }
    );
  }

  let body: { projectId?: string; title?: string; brief?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const projectId = body.projectId?.trim() ?? "";
  if (!projectId || projectId.length > 64) {
    return NextResponse.json(
      { error: "projectId (client-generated, max 64 chars) is required" },
      { status: 400 }
    );
  }
  const title = (body.title?.trim() || "New project").slice(0, 200);
  const brief = body.brief?.trim().slice(0, 20000) || null;

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const existing = t.projects.find((p) => p.id === projectId);
    if (existing) {
      return NextResponse.json({ projectId, created: false, simulated: true });
    }
    const now = new Date();
    t.projects.push({
      id: projectId,
      companyId: t.companies[0]?.id ?? "demo-company-technova",
      title,
      rawBrief: brief,
      structuredBrief: null,
      structuredPlan: null,
      sanitizedSummary: null,
      githubRepoUrl: null,
      acceptanceCriteria: null,
      status: "draft",
      autoApproveThresholdUsd: "500.00",
      createdAt: now,
      updatedAt: now,
    });
    await writeAuditLog({
      entityType: "project",
      entityId: projectId,
      event: "PROJECT_CREATED",
      actor: `${role}-operator`,
      payload: { title },
    });
    return NextResponse.json(
      { projectId, created: true, simulated: true },
      { status: 201 }
    );
  }

  // Demo: resolve companyId from seeded company (matches previous behavior).
  const companyId = "company-1";

  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (existing) {
    // Idempotent replay — no duplicate row.
    return NextResponse.json({ projectId, created: false });
  }

  await db
    .insert(projects)
    .values({
      id: projectId,
      companyId,
      title,
      rawBrief: brief,
      status: "draft",
    })
    .onConflictDoNothing();

  await writeAuditLog({
    entityType: "project",
    entityId: projectId,
    event: "PROJECT_CREATED",
    actor: `${role}-operator`,
    payload: { title },
  });

  return NextResponse.json({ projectId, created: true }, { status: 201 });
}
