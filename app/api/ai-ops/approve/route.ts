/**
 * POST /api/ai-ops/approve
 *
 * Human Authorization Gate for Pending Agent Executions, Scheduling Proposals,
 * and Financial Proposals.
 *
 * Section 5 & Section 6 Guarantees:
 * - Only human operators with role 'company' or 'admin' can authorize.
 * - AI agents are strictly forbidden from calling or authorizing this endpoint.
 * - When a scheduling proposal is approved, applies validated date shifts to
 *   unlocked milestones in Neon PostgreSQL and records an immutable audit log entry.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import {
  agentExecutions,
  schedulingProposals,
  milestones,
} from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { ensureAiOpsTables, type MilestoneAdjustmentItem } from "@/lib/ai-ops/orchestrator-engine";
import { eq, and, sql } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: require verified role=company or role=admin cookie ──────────────
  // No body fallback: self-asserted actor_role must never authorize proposals.
  const actorRole = await getRoleFromCookie(req.headers.get("cookie"));
  if (actorRole !== "company" && actorRole !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: Only company or admin human operators can authorize proposals." },
      { status: 403 }
    );
  }

  // ── Rate limit: 10 approvals per IP per 60 s ──────────────────────────────
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("ai-ops-approve", ip, 10, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  try {
    await ensureAiOpsTables();

    const body = await req.json().catch(() => null);

    const executionId = body?.execution_id ?? body?.executionId;
    const proposalId = body?.proposal_id ?? body?.proposalId;
    const decision = body?.decision as "approved" | "rejected" | undefined;
    const actorId = (body?.actor_id ?? body?.actorId ?? "company-human-reviewer").trim();
    const reason = (body?.reason ?? "Reviewed and authorized by human operator").trim();

    if (!decision || (decision !== "approved" && decision !== "rejected")) {
      return NextResponse.json(
        { error: "decision must be 'approved' or 'rejected'." },
        { status: 400 }
      );
    }

    // Block AI actor spoofing
    const lowerActor = actorId.toLowerCase();
    if (
      lowerActor === "ai" ||
      lowerActor === "agent" ||
      lowerActor.startsWith("ai-") ||
      lowerActor.startsWith("agent-") ||
      lowerActor.includes("supervisor")
    ) {
      return NextResponse.json(
        {
          error:
            "Security Policy Violation: AI agents cannot independently authorize financial transfers or schedule mutations.",
        },
        { status: 403 }
      );
    }

    if (isDemoMode()) {
      const { getDemoTables } = await import("@/lib/demo/store");
      const t = getDemoTables();
      let appliedScheduleCount = 0;
      const targets = proposalId
        ? t.schedulingProposals.filter((sp) => sp.id === proposalId)
        : executionId
          ? t.schedulingProposals.filter((sp) => sp.executionId === executionId)
          : [];
      for (const sp of targets) {
        if (decision === "approved") {
          const adjustments = (Array.isArray(sp.adjustments)
            ? sp.adjustments
            : []) as Array<Record<string, unknown>>;
          for (const adj of adjustments) {
            const taskId =
              (adj.task_id as string | undefined) ??
              (adj.milestone_id as string | undefined);
            const endDate =
              (adj.proposed_end_date as string | undefined) ??
              (adj.new_value as string | undefined);
            if (!taskId || !endDate) continue;
            const ms = t.milestones.find((m) => m.id === taskId);
            if (ms && ms.status !== "funded" && ms.status !== "paid") {
              const startDate =
                (adj.proposed_start_date as string | undefined) ??
                ms.startDate;
              ms.startDate = startDate ?? ms.startDate;
              ms.dueDate = endDate.slice(0, 10);
              ms.version += 1;
              ms.updatedAt = new Date();
              appliedScheduleCount++;
            }
          }
        }
        sp.status = decision === "approved" ? "approved" : "rejected";
        sp.decidedBy = actorId;
        sp.decidedAt = new Date();
        sp.updatedAt = new Date();
        await writeAuditLog({
          entityType: "scheduling_proposal",
          entityId: sp.id,
          event:
            decision === "approved"
              ? "SCHEDULING_PROPOSAL_APPROVED_AND_APPLIED"
              : "SCHEDULING_PROPOSAL_REJECTED",
          actor: actorId,
          payload: {
            projectId: sp.projectId,
            executionId: sp.executionId,
            appliedScheduleCount,
            reason,
          },
        });
      }
      const targetExecId = executionId ?? targets[0]?.executionId;
      if (targetExecId) {
        const exec = t.agentExecutions.find((e) => e.id === targetExecId);
        if (exec) {
          exec.status = decision === "approved" ? "completed" : "failed";
          exec.approvalStatus = decision;
          exec.decidedBy = actorId;
          exec.decidedAt = new Date();
          exec.updatedAt = new Date();
        }
        await writeAuditLog({
          entityType: "agent_execution",
          entityId: targetExecId,
          event: `AGENT_EXECUTION_${decision.toUpperCase()}`,
          actor: actorId,
          payload: { decision, reason, appliedScheduleCount },
        });
      }
      return NextResponse.json({
        ok: true,
        execution_id: targetExecId ?? null,
        proposal_id: proposalId ?? null,
        decision,
        decided_by: actorId,
        applied_schedule_adjustments: appliedScheduleCount,
        decided_at: new Date().toISOString(),
        simulated: true,
      });
    }

    let appliedScheduleCount = 0;

    // 1. If a scheduling proposal ID is provided (or linked to executionId), update & apply if approved
    const targetSchedProposals = proposalId
      ? await db
          .select()
          .from(schedulingProposals)
          .where(eq(schedulingProposals.id, proposalId))
      : executionId
      ? await db
          .select()
          .from(schedulingProposals)
          .where(eq(schedulingProposals.executionId, executionId))
      : [];

    for (const sp of targetSchedProposals) {
      if (decision === "approved") {
        const adjustments = (Array.isArray(sp.adjustments)
          ? sp.adjustments
          : []) as MilestoneAdjustmentItem[];

        for (const adj of adjustments) {
          if (!adj.task_id || !adj.proposed_end_date) continue;
          // Never mutate funded or paid milestones
          const [ms] = await db
            .select()
            .from(milestones)
            .where(eq(milestones.id, adj.task_id))
            .limit(1);

          if (ms && ms.status !== "funded" && ms.status !== "paid") {
            await db
              .update(milestones)
              .set({
                startDate: adj.proposed_start_date?.slice(0, 10) ?? ms.startDate,
                dueDate: adj.proposed_end_date.slice(0, 10),
                version: sql`${milestones.version} + 1`,
                updatedAt: new Date(),
              })
              .where(and(eq(milestones.id, ms.id)));
            appliedScheduleCount++;
          }
        }
      }

      await db
        .update(schedulingProposals)
        .set({
          status: decision === "approved" ? "approved" : "rejected",
          decidedBy: actorId,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schedulingProposals.id, sp.id));

      await writeAuditLog({
        entityType: "scheduling_proposal",
        entityId: sp.id,
        event:
          decision === "approved"
            ? "SCHEDULING_PROPOSAL_APPROVED_AND_APPLIED"
            : "SCHEDULING_PROPOSAL_REJECTED",
        actor: actorId,
        payload: {
          projectId: sp.projectId,
          executionId: sp.executionId,
          appliedScheduleCount,
          reason,
        },
      });
    }

    // 2. Update execution status if executionId is provided
    const targetExecId = executionId ?? targetSchedProposals[0]?.executionId;
    if (targetExecId) {
      await db
        .update(agentExecutions)
        .set({
          status: decision === "approved" ? "completed" : "failed",
          approvalStatus: decision,
          decidedBy: actorId,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentExecutions.id, targetExecId));

      await writeAuditLog({
        entityType: "agent_execution",
        entityId: targetExecId,
        event: `AGENT_EXECUTION_${decision.toUpperCase()}`,
        actor: actorId,
        payload: {
          decision,
          reason,
          appliedScheduleCount,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      execution_id: targetExecId ?? null,
      proposal_id: proposalId ?? null,
      decision,
      decided_by: actorId,
      applied_schedule_adjustments: appliedScheduleCount,
      decided_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/ai-ops/approve] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
