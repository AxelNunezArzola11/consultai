/**
 * POST /api/db/save-brief
 *
 * Direct DB write — no LLM overhead. Called by the "Approve & Save Plan"
 * button in ChatPanel after the user reviews the AI-generated plan.
 *
 * Body: { projectId: string; agentSessionId: string; plan: BriefPlan }
 * Returns: { ok: true; milestoneCount: number; downgradedCriteria: string[] }
 *       or { ok: false; errors: string[] }
 *
 * Error policy: NO silent swallowing. Every DB failure throws → caught at the
 * top level → returned as { ok: false, errors: [msg] } with status 500.
 * The UI must show this error; it must never render success on a failed save.
 */

import { NextRequest, after } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { projects, milestones, auditLog, briefDrafts } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { normalizeBriefPlan } from "@/lib/brief/schema";
import { isDemoMode } from "@/lib/demo/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // ── 0. Authorization: company or admin only ─────────────────────────────────
  const { getRoleFromCookie } = await import("@/lib/auth/role-cookie");
  const { companySessionAllowsLiveAccess, getSessionFromCookie } = await import("@/lib/auth/session");
  const { checkRateLimit, getIp } = await import("@/lib/auth/rate-limit");
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return Response.json(
      { ok: false, errors: ["Saving plans requires the company or admin role. Use Switch Role to continue as a company operator."] },
      { status: 403 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return Response.json(
      { ok: false, errors: ["Live mode requires a verified company session."] },
      { status: 403 }
    );
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("save-brief", ip, 10, 60);
  if (!ok) {
    return Response.json(
      { ok: false, errors: ["Rate limit exceeded"] },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: {
    projectId?: string;
    agentSessionId?: string;
    plan?: unknown;
    projectTitle?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, errors: ["Invalid JSON body"] }, { status: 400 });
  }

  const { projectId, agentSessionId, plan, projectTitle } = body;

  if (!projectId || typeof projectId !== "string" || projectId.length > 100) {
    return Response.json({ ok: false, errors: ["projectId required"] }, { status: 400 });
  }
  if (!agentSessionId || typeof agentSessionId !== "string" || agentSessionId.length > 100) {
    return Response.json({ ok: false, errors: ["agentSessionId required"] }, { status: 400 });
  }
  if (!plan || typeof plan !== "object") {
    return Response.json({ ok: false, errors: ["plan required"] }, { status: 400 });
  }

  console.log("[save-brief] incoming:", { projectId, agentSessionId, planKeys: Object.keys(plan as object) });

  // ── Demo mode: same validation, writes go to the isolated in-memory store ──
  if (isDemoMode()) {
    const { getDemoTables, appendDemoAudit } = await import("@/lib/demo/store");
    const {
      demoCompanyForSession,
      resolveDemoDraftForPlanning,
    } = await import("@/lib/demo/drafts");
    const t = getDemoTables();
    let project = t.projects.find((p) => p.id === projectId);
    // Serverless-safe: a cold instance rehydrates the POST-accepted draft
    // from the creation title; bare IDs still 404 honestly.
    if (!project) {
      const rehydrated = resolveDemoDraftForPlanning({
        projectId,
        title: projectTitle,
        companyId: demoCompanyForSession(session?.companyId),
      });
      if (rehydrated) {
        project = t.projects.find((p) => p.id === projectId);
      }
    }
    if (!project) {
      return Response.json({ ok: false, errors: ["Project not found"] }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId &&
        project.companyId !== session.companyId) {
      return Response.json({ ok: false, errors: ["Forbidden"] }, { status: 403 });
    }
    const { plan: normalized, downgradedCriteria, errors } = normalizeBriefPlan(plan);
    if (errors.length > 0) {
      return Response.json({ ok: false, errors }, { status: 422 });
    }
    if (
      normalized.projectTitle &&
      normalized.projectTitle.trim() &&
      (!project.title || project.title === "New project")
    ) {
      project.title = normalized.projectTitle.trim().slice(0, 200);
    }
    const flattenedCriteria = normalized.milestones.flatMap(
      (m) => m.acceptanceCriteria ?? []
    );
    project.status = "active";
    project.structuredPlan = normalized as Record<string, unknown>;
    project.acceptanceCriteria = flattenedCriteria as unknown;
    project.updatedAt = new Date();
    t.milestones = t.milestones.filter(
      (m) => !(m.projectId === projectId && m.status === "planned")
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    normalized.milestones.forEach((m, i) => {
      const dueDate = new Date(today.getTime() + m.dueDaysOffset * 24 * 60 * 60 * 1000);
      const now = new Date();
      t.milestones.push({
        id: `${projectId}_m${i + 1}`,
        projectId,
        title: m.title,
        description: m.description ?? null,
        budgetUsd: String(m.budgetUsd),
        dueDate: dueDate.toISOString().slice(0, 10),
        status: "planned",
        dependsOnId: null,
        offsetDays: null,
        startDate: null,
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
        position: i,
        createdAt: now,
        updatedAt: now,
      });
    });
    appendDemoAudit({
      entityType: "project",
      entityId: projectId,
      event: "BRIEF_SAVED",
      actor: "company",
      payload: {
        projectTitle: normalized.projectTitle,
        milestoneCount: normalized.milestones.length,
        totalBudgetUsd: normalized.totalBudgetUsd,
      },
    });
    try {
      revalidatePath("/dashboard");
      revalidatePath("/planning");
      revalidatePath("/operations");
      revalidatePath(`/project/${projectId}/milestones`);
    } catch {
      // revalidatePath may no-op in unit tests outside Next request context
    }
    return Response.json({
      ok: true,
      projectTitle: project.title,
      status: project.status,
      milestoneCount: normalized.milestones.length,
      totalBudgetUsd: normalized.totalBudgetUsd,
      downgradedCriteria,
      simulated: true,
    });
  }

  // ── 2. Validate project exists ─────────────────────────────────────────────
  const projectRows = await db
    .select({ id: projects.id, title: projects.title, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (projectRows.length === 0) {
    console.error("[save-brief] project not found:", projectId);
    return Response.json({ ok: false, errors: ["Project not found"] }, { status: 404 });
  }
  const existingProject = projectRows[0];
  if (session?.role === "company" && session.companyId &&
      existingProject.companyId !== session.companyId) {
    return Response.json({ ok: false, errors: ["Forbidden"] }, { status: 403 });
  }

  // ── 3. Normalize + validate plan ───────────────────────────────────────────
  const { plan: normalized, downgradedCriteria, errors } = normalizeBriefPlan(plan);
  if (errors.length > 0) {
    console.error("[save-brief] plan validation errors:", errors);
    return Response.json({ ok: false, errors }, { status: 422 });
  }

  const resolvedTitle =
    normalized.projectTitle &&
    normalized.projectTitle.trim() &&
    (!existingProject.title || existingProject.title === "New project")
      ? normalized.projectTitle.trim().slice(0, 200)
      : existingProject.title || normalized.projectTitle || "New project";

  console.log("[save-brief] plan validated:", {
    projectTitle: resolvedTitle,
    totalBudgetUsd: normalized.totalBudgetUsd,
    milestoneCount: normalized.milestones.length,
    milestones: normalized.milestones.map((m, i) => ({
      index: i,
      title: m.title,
      budgetUsd: m.budgetUsd,
      dueDaysOffset: m.dueDaysOffset,
    })),
  });

  // ── 4. Critical DB writes — NO try/catch: any failure propagates to caller ─
  // The outer try/catch in the Next.js handler will catch these and the
  // explicit catch below returns a 500 with the real error message.
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 4a. Update projects.structured_plan, title, status, and acceptanceCriteria
    const flattenedCriteria = normalized.milestones.flatMap(
      (m) => m.acceptanceCriteria ?? []
    );
    console.log("[save-brief] updating projects.structured_plan for:", projectId);
    const updateResult = await db
      .update(projects)
      .set({
        title: resolvedTitle,
        status: "active",
        structuredPlan: normalized as Record<string, unknown>,
        acceptanceCriteria: flattenedCriteria as unknown,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
    console.log("[save-brief] projects.structured_plan updated:", updateResult);

    // 4b. Delete existing "planned" milestones for this project (idempotent re-save).
    //     Never delete funded/paid/verifying rows — they have live PayPal references.
    console.log("[save-brief] deleting existing planned milestones for:", projectId);
    const deleteResult = await db
      .delete(milestones)
      .where(and(
        eq(milestones.projectId, projectId),
        eq(milestones.status, "planned"),
      ));
    console.log("[save-brief] planned milestones deleted:", deleteResult);

    // 4c. Insert one row per milestone.
    //     ID = "${projectId}_m${i+1}" — project-scoped, never collides across projects.
    //     Do NOT use the AI-generated m.id ("m1", "m2"…) — the template reuses those
    //     across every project, causing primary-key violations on the second save.
    for (let i = 0; i < normalized.milestones.length; i++) {
      const m = normalized.milestones[i];
      const dueDate = new Date(today.getTime() + m.dueDaysOffset * 24 * 60 * 60 * 1000);
      const dueDateStr = dueDate.toISOString().slice(0, 10); // YYYY-MM-DD
      const milestoneDbId = `${projectId}_m${i + 1}`;

      console.log(`[save-brief] inserting milestone ${i + 1}/${normalized.milestones.length}:`, {
        id: milestoneDbId,
        title: m.title,
        budgetUsd: m.budgetUsd,
        dueDate: dueDateStr,
      });

      await db.insert(milestones).values({
        id: milestoneDbId,
        projectId,
        title: m.title,
        description: m.description ?? null,
        budgetUsd: String(m.budgetUsd),
        dueDate: dueDateStr,
        status: "planned",
        position: i,
        // createdAt / updatedAt have DB defaults; updatedAt is repeated here
        // to be explicit (schema has .defaultNow() so omitting is also fine)
        updatedAt: new Date(),
      });

      console.log(`[save-brief] milestone ${i + 1} inserted OK: ${milestoneDbId}`);
    }

  } catch (dbErr) {
    const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
    console.error("[save-brief] DB write failed:", msg, dbErr);
    return Response.json(
      { ok: false, errors: [`Database error: ${msg}`] },
      { status: 500 },
    );
  }

  // ── 5. Non-critical writes — deferred via after() ─────────────────────────
  // These run after the response is sent. Errors here are logged but do NOT
  // affect the success response — draft + audit are non-blocking.
  const draftId = nanoid();
  after(async () => {
    try {
      await Promise.all([
        db
          .insert(briefDrafts)
          .values({
            id: draftId,
            projectId,
            agentSessionId,
            planJson: normalized as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .onConflictDoNothing(),
        db.insert(auditLog).values({
          entityType: "project",
          entityId: projectId,
          event: "BRIEF_SAVED",
          actor: "company",
          payload: {
            projectTitle: normalized.projectTitle,
            milestoneCount: normalized.milestones.length,
            totalBudgetUsd: normalized.totalBudgetUsd,
            downgradedCriteria,
            source: "approve-button",
          } as Record<string, unknown>,
        }),
      ]);
      console.log("[save-brief] deferred writes (draft + audit) completed");
    } catch (deferredErr) {
      // Non-fatal: log but don't surface to the user
      console.error("[save-brief] deferred write failed (non-fatal):", deferredErr);
    }
  });

  console.log("[save-brief] success:", {
    projectId,
    milestoneCount: normalized.milestones.length,
    totalBudgetUsd: normalized.totalBudgetUsd,
  });

  try {
    revalidatePath("/dashboard");
    revalidatePath("/planning");
    revalidatePath("/operations");
    revalidatePath(`/project/${projectId}/milestones`);
  } catch {
    // revalidatePath may no-op in unit tests outside Next request context
  }

  return Response.json({
    ok: true,
    projectTitle: resolvedTitle,
    status: "active",
    milestoneCount: normalized.milestones.length,
    totalBudgetUsd: normalized.totalBudgetUsd,
    downgradedCriteria,
  });
}
