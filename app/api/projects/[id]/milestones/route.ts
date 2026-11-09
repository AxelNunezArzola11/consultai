/**
 * POST /api/projects/[id]/milestones
 *
 * Creates a milestone from a Bryntum Gantt drop (backlog scheduling).
 * The client inserts a temp-id task optimistically, then calls here to
 * persist; the response carries the server id + version for store remap.
 *
 * Guards (same shape as the sibling reorder route):
 * - company/admin role required (session-first)
 * - session companyId vs project.companyId scoping (403 cross-company)
 * - Zod body validation, rate limit 30/60
 * - audit log MILESTONE_CREATED
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { milestones, projects } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { writeAuditLog } from "@/lib/db/audit";
import { addDays } from "@/lib/scheduling/dependency-engine";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

const CreateBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
  durationDays: z.number().int().min(0).max(365).optional().default(1),
  budgetUsd: z.number().positive().max(100_000_000).optional(),
});

function newMilestoneId(projectId: string): string {
  // Project-scoped + time-ordered; never collides across projects or retries.
  return `${projectId}_m${Date.now().toString(36)}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden: company role required" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("milestone-create", ip, 30, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  const { id: projectId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { title, startDate, durationDays, budgetUsd } = parsed.data;
  const dueDate = addDays(startDate, Math.max(durationDays, 0));

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const demoProject = t.projects.find((p) => p.id === projectId);
    if (!demoProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId && demoProject.companyId !== session.companyId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const position = t.milestones.filter((m) => m.projectId === projectId).length;
    const milestoneId = newMilestoneId(projectId);
    t.milestones.push({
      id: milestoneId,
      projectId,
      title,
      description: null,
      budgetUsd: budgetUsd !== undefined ? budgetUsd.toFixed(2) : "0.00",
      dueDate,
      status: "planned",
      dependsOnId: null,
      offsetDays: null,
      startDate,
      version: 0,
      paypalOrderId: null,
      paypalCaptureId: null,
      captureGrossUsd: null,
      captureFeeUsd: null,
      captureNetUsd: null,
      currency: null,
      paypalPayoutBatchId: null,
      paypalPayoutItemId: null,
      idempotencyKey: null,
      position,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await writeAuditLog({
      entityType: "milestone",
      entityId: milestoneId,
      event: "MILESTONE_CREATED",
      actor: session ? `${session.role}:${session.userId}` : `${role ?? "company"}-operator`,
      payload: { projectId, title, startDate, dueDate, position },
    });
    return NextResponse.json({
      ok: true,
      milestone: { id: milestoneId, projectId, title, startDate, dueDate, version: 0, position },
      simulated: true,
    });
  }

  const [project] = await db
    .select({ id: projects.id, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (session?.role === "company" && session.companyId && project.companyId !== session.companyId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [last] = await db
    .select({ position: milestones.position })
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
    .orderBy(desc(milestones.position))
    .limit(1);
  const position = (last?.position ?? -1) + 1;
  const milestoneId = newMilestoneId(projectId);

  const [inserted] = await db
    .insert(milestones)
    .values({
      id: milestoneId,
      projectId,
      title,
      budgetUsd: budgetUsd !== undefined ? budgetUsd.toFixed(2) : "0.00",
      startDate,
      dueDate,
      status: "planned",
      position,
      updatedAt: new Date(),
    })
    .returning({ id: milestones.id, version: milestones.version });

  await writeAuditLog({
    entityType: "milestone",
    entityId: milestoneId,
    event: "MILESTONE_CREATED",
    actor: session ? `${session.role}:${session.userId}` : `${role ?? "company"}-operator`,
    payload: { projectId, title, startDate, dueDate, position },
  });

  return NextResponse.json({
    ok: true,
    milestone: {
      id: inserted.id,
      projectId,
      title,
      startDate,
      dueDate,
      version: inserted.version,
      position,
    },
  });
}
