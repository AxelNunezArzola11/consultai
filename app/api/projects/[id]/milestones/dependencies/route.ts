/**
 * POST / DELETE /api/projects/[id]/milestones/dependencies
 *
 * Persists Bryntum Gantt dependency links (Finish-to-Start) as
 * milestone.dependsOnId + offsetDays. The reorder route stays date-only.
 *
 * POST   { milestoneId, dependsOnId, offsetDays?, expectedVersion? }
 *        → upserts the link, bumps version, runs the BFS date recalculation.
 * DELETE { milestoneId, expectedVersion? }
 *        → clears dependsOnId/offsetDays (unlink), bumps version.
 *
 * Guards:
 * - company/admin role required (session-first); session company scoping (403)
 * - funded/locked child milestones reject with 409 (financial consistency)
 * - self-dependency + cycle detection via a recalculateDates dry-run (409)
 * - optimistic version check when expectedVersion is supplied
 * - rate limit 30/60; audit log DEPENDENCY_UPSERTED / DEPENDENCY_REMOVED
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { milestones, projects } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { writeAuditLog } from "@/lib/db/audit";
import {
  isFunded,
  recalculateDates,
  applyDateRecalculation,
  type MilestoneNode,
} from "@/lib/scheduling/dependency-engine";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

const UpsertSchema = z.object({
  milestoneId: z.string().min(1).max(100),
  dependsOnId: z.string().min(1).max(100),
  offsetDays: z.number().int().min(0).max(365).optional().default(1),
  expectedVersion: z.number().int().nonnegative().optional(),
});

const RemoveSchema = z.object({
  milestoneId: z.string().min(1).max(100),
  expectedVersion: z.number().int().nonnegative().optional(),
});

async function authorize(req: NextRequest) {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden: company role required" }, { status: 403 }) };
  }
  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return { error: NextResponse.json({ error: "missing_company_context" }, { status: 403 }) };
  }
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("milestone-dependencies", ip, 30, 60);
  if (!ok) {
    return {
      error: NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
      ),
    };
  }
  return { session, role };
}

function actorOf(session: { role: string; userId: string } | null, role: string | null): string {
  return session ? `${session.role}:${session.userId}` : `${role ?? "company"}-operator`;
}

/** Dry-run cycle check: simulate the link, then BFS from the parent. */
function wouldCycle(nodes: MilestoneNode[], milestoneId: string, dependsOnId: string): boolean {
  const simulated = nodes.map((n) =>
    n.id === milestoneId ? { ...n, dependsOnId, offsetDays: n.offsetDays ?? 1 } : n
  );
  const { warnings } = recalculateDates(simulated, [dependsOnId]);
  return warnings.some((w) => w.startsWith("Cycle detected"));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const auth = await authorize(req);
  if ("error" in auth) return auth.error;
  const { session, role } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = UpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { milestoneId, dependsOnId, offsetDays, expectedVersion } = parsed.data;

  if (milestoneId === dependsOnId) {
    return NextResponse.json({ error: "A milestone cannot depend on itself." }, { status: 409 });
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const demoProject = t.projects.find((p) => p.id === projectId);
    if (!demoProject) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (session?.role === "company" && session.companyId && demoProject.companyId !== session.companyId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const child = t.milestones.find((m) => m.id === milestoneId && m.projectId === projectId);
    const parent = t.milestones.find((m) => m.id === dependsOnId && m.projectId === projectId);
    if (!child || !parent) {
      return NextResponse.json({ error: "Milestone not found in this project" }, { status: 404 });
    }
    if (isFunded(child.status)) {
      return NextResponse.json(
        { error: `Cannot change dependencies of a milestone in status "${child.status}".`, status: child.status },
        { status: 409 }
      );
    }
    if (expectedVersion !== undefined && child.version !== expectedVersion) {
      return NextResponse.json({ error: "Optimistic concurrency conflict.", expectedVersion }, { status: 409 });
    }
    const nodes: MilestoneNode[] = t.milestones
      .filter((m) => m.projectId === projectId)
      .map((m) => ({
        id: m.id, projectId: m.projectId, title: m.title, dueDate: m.dueDate,
        status: m.status, dependsOnId: m.dependsOnId, offsetDays: m.offsetDays,
      }));
    if (wouldCycle(nodes, milestoneId, dependsOnId)) {
      return NextResponse.json({ error: "Dependency would create a cycle." }, { status: 409 });
    }
    child.dependsOnId = dependsOnId;
    child.offsetDays = offsetDays;
    child.version += 1;
    child.updatedAt = new Date();
    await writeAuditLog({
      entityType: "milestone",
      entityId: milestoneId,
      event: "DEPENDENCY_UPSERTED",
      actor: actorOf(session, role),
      payload: { projectId, dependsOnId, offsetDays, newVersion: child.version },
    });
    return NextResponse.json({
      ok: true, milestoneId, dependsOnId, offsetDays, version: child.version, simulated: true,
    });
  }

  const [project] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (session?.role === "company" && session.companyId && project.companyId !== session.companyId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await db.select().from(milestones).where(eq(milestones.projectId, projectId));
  const child = rows.find((m) => m.id === milestoneId);
  const parent = rows.find((m) => m.id === dependsOnId);
  if (!child || !parent) {
    return NextResponse.json({ error: "Milestone not found in this project" }, { status: 404 });
  }
  if (isFunded(child.status)) {
    return NextResponse.json(
      { error: `Cannot change dependencies of a milestone in status "${child.status}".`, status: child.status },
      { status: 409 }
    );
  }
  if (expectedVersion !== undefined && child.version !== expectedVersion) {
    return NextResponse.json({ error: "Optimistic concurrency conflict.", expectedVersion }, { status: 409 });
  }
  const nodes: MilestoneNode[] = rows.map((m) => ({
    id: m.id, projectId: m.projectId, title: m.title, dueDate: m.dueDate,
    status: m.status, dependsOnId: m.dependsOnId, offsetDays: m.offsetDays,
  }));
  if (wouldCycle(nodes, milestoneId, dependsOnId)) {
    return NextResponse.json({ error: "Dependency would create a cycle." }, { status: 409 });
  }

  const updated = await db
    .update(milestones)
    .set({ dependsOnId, offsetDays, version: child.version + 1, updatedAt: new Date() })
    .where(
      expectedVersion !== undefined
        ? and(eq(milestones.id, milestoneId), eq(milestones.version, expectedVersion))
        : eq(milestones.id, milestoneId)
    )
    .returning({ version: milestones.version });
  if (updated.length === 0) {
    return NextResponse.json({ error: "Optimistic concurrency conflict.", expectedVersion }, { status: 409 });
  }

  // BFS cascade: downstream due_dates follow the new link (funded skipped).
  const recalc = await applyDateRecalculation(projectId, [milestoneId]);

  await writeAuditLog({
    entityType: "milestone",
    entityId: milestoneId,
    event: "DEPENDENCY_UPSERTED",
    actor: actorOf(session, role),
    payload: {
      projectId, dependsOnId, offsetDays, newVersion: updated[0].version,
      recalcUpdated: recalc.updatedMilestones.length, recalcSkippedFunded: recalc.skippedFunded,
    },
  });

  return NextResponse.json({
    ok: true,
    milestoneId,
    dependsOnId,
    offsetDays,
    version: updated[0].version,
    recalc: {
      updated: recalc.updatedMilestones,
      skippedFunded: recalc.skippedFunded,
      warnings: recalc.warnings,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const auth = await authorize(req);
  if ("error" in auth) return auth.error;
  const { session, role } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = RemoveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { milestoneId, expectedVersion } = parsed.data;

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const demoProject = t.projects.find((p) => p.id === projectId);
    if (!demoProject) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (session?.role === "company" && session.companyId && demoProject.companyId !== session.companyId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const child = t.milestones.find((m) => m.id === milestoneId && m.projectId === projectId);
    if (!child) {
      return NextResponse.json({ error: "Milestone not found in this project" }, { status: 404 });
    }
    if (isFunded(child.status)) {
      return NextResponse.json(
        { error: `Cannot change dependencies of a milestone in status "${child.status}".`, status: child.status },
        { status: 409 }
      );
    }
    if (expectedVersion !== undefined && child.version !== expectedVersion) {
      return NextResponse.json({ error: "Optimistic concurrency conflict.", expectedVersion }, { status: 409 });
    }
    child.dependsOnId = null;
    child.offsetDays = null;
    child.version += 1;
    child.updatedAt = new Date();
    await writeAuditLog({
      entityType: "milestone",
      entityId: milestoneId,
      event: "DEPENDENCY_REMOVED",
      actor: actorOf(session, role),
      payload: { projectId, newVersion: child.version },
    });
    return NextResponse.json({ ok: true, milestoneId, version: child.version, simulated: true });
  }

  const [project] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (session?.role === "company" && session.companyId && project.companyId !== session.companyId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [child] = await db
    .select()
    .from(milestones)
    .where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId)))
    .limit(1);
  if (!child) {
    return NextResponse.json({ error: "Milestone not found in this project" }, { status: 404 });
  }
  if (isFunded(child.status)) {
    return NextResponse.json(
      { error: `Cannot change dependencies of a milestone in status "${child.status}".`, status: child.status },
      { status: 409 }
    );
  }

  const updated = await db
    .update(milestones)
    .set({ dependsOnId: null, offsetDays: null, version: child.version + 1, updatedAt: new Date() })
    .where(
      expectedVersion !== undefined
        ? and(eq(milestones.id, milestoneId), eq(milestones.version, expectedVersion))
        : eq(milestones.id, milestoneId)
    )
    .returning({ version: milestones.version });
  if (updated.length === 0) {
    return NextResponse.json({ error: "Optimistic concurrency conflict.", expectedVersion }, { status: 409 });
  }

  await writeAuditLog({
    entityType: "milestone",
    entityId: milestoneId,
    event: "DEPENDENCY_REMOVED",
    actor: actorOf(session, role),
    payload: { projectId, newVersion: updated[0].version },
  });

  return NextResponse.json({ ok: true, milestoneId, version: updated[0].version });
}
