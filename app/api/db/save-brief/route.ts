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
import { db } from "@/lib/db";
import { projects, milestones, auditLog, briefDrafts } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { normalizeBriefPlan } from "@/lib/brief/schema";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: { projectId?: string; agentSessionId?: string; plan?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, errors: ["Invalid JSON body"] }, { status: 400 });
  }

  const { projectId, agentSessionId, plan } = body;

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

  // ── 2. Validate project exists ─────────────────────────────────────────────
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (projectRows.length === 0) {
    console.error("[save-brief] project not found:", projectId);
    return Response.json({ ok: false, errors: ["Project not found"] }, { status: 404 });
  }

  // ── 3. Normalize + validate plan ───────────────────────────────────────────
  const { plan: normalized, downgradedCriteria, errors } = normalizeBriefPlan(plan);
  if (errors.length > 0) {
    console.error("[save-brief] plan validation errors:", errors);
    return Response.json({ ok: false, errors }, { status: 422 });
  }

  console.log("[save-brief] plan validated:", {
    projectTitle: normalized.projectTitle,
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

    // 4a. Update projects.structured_plan
    console.log("[save-brief] updating projects.structured_plan for:", projectId);
    const updateResult = await db
      .update(projects)
      .set({
        structuredPlan: normalized as Record<string, unknown>,
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

  return Response.json({
    ok: true,
    milestoneCount: normalized.milestones.length,
    totalBudgetUsd: normalized.totalBudgetUsd,
    downgradedCriteria,
  });
}
