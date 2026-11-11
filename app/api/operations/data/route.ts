/**
 * GET & PATCH /api/operations/data
 *
 * Unified Enterprise Operations API for AG Grid Management Views (Section 7):
 * 1. Consultants (`candidates` + `signals`)
 * 2. Projects (`projects` + `companies`)
 * 3. Tasks (`milestones` synchronized with Bryntum Gantt)
 * 4. Companies (`companies` + project/budget rollups)
 * 5. Contracts (`ndas` + `meetings`)
 * 6. Payments (`payments` + `approvals` + `payment_proposals`)
 * 7. Agent Executions (`agent_executions` + `verification_runs`)
 *
 * Also supports inline editing mutations (PATCH) with deterministic validation,
 * optimistic concurrency checks, and append-only audit logging.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  companies,
  projects,
  milestones,
  candidates,
  ndas,
  meetings,
  payments,
  approvals,
  paymentProposals,
  verificationRuns,
  agentExecutions,
  disputes,
} from "@/lib/db/schema";
import { ensureAiOpsTables } from "@/lib/ai-ops/orchestrator-engine";
import { writeAuditLog } from "@/lib/db/audit";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { desc, eq, sql } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { withTimeout } from "@/lib/db/with-timeout";

export const dynamic = "force-dynamic";

// ── Shared consultant-update validation (demo + live must behave identically) ──
// Mirrors candidateStatusEnum in lib/db/schema.ts — keep in sync.
const VALID_CANDIDATE_STATUSES = new Set([
  "pending", "shortlisted", "nda_sent", "nda_signed", "scheduled",
  "selected", "rejected", "cascaded", "found", "booking_unlocked",
  "booked", "meeting_held", "declined", "expired", "cancelled",
  "no_show", "invalid_booking",
]);

const VALID_TABS = [
  "consultants",
  "projects",
  "tasks",
  "companies",
  "contracts",
  "payments",
  "executions",
] as const;
type OperationsTab = (typeof VALID_TABS)[number];

/** Contracts grid never carries full document hashes — last4 marker only. */
function redactDocumentHash(hash: string | null | undefined): string {
  if (!hash || hash === "—") return "—";
  return `sha256:…${hash.slice(-4)}`;
}

function validateConsultantUpdates(updates: Record<string, unknown>): {
  rank?: number;
  status?: string;
  error?: string;
} {
  const out: { rank?: number; status?: string; error?: string } = {};
  if (updates.rank !== undefined) {
    const r = Number(updates.rank);
    if (!Number.isInteger(r) || r < 1 || r > 100) {
      return { error: "rank must be an integer between 1 and 100." };
    }
    out.rank = r;
  }
  if (updates.status !== undefined) {
    if (typeof updates.status !== "string" || !VALID_CANDIDATE_STATUSES.has(updates.status)) {
      return { error: `status must be one of: ${[...VALID_CANDIDATE_STATUSES].join(", ")}.` };
    }
    out.status = updates.status;
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const cookieHeader = req.headers.get("cookie") ?? null;
    const session = await getSessionFromCookie(cookieHeader);
    const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
    if (role !== "company" && role !== "admin") {
      return NextResponse.json(
        {
          error: "forbidden",
          message: "Enterprise operations and financial grids require the company or admin role.",
        },
        { status: 403 }
      );
    }

    // Live mode: company callers need a verified session (D.3 — a bare role
    // cookie must never authorize company access, and must never receive
    // the unscoped multi-company payload below).
    if (!companySessionAllowsLiveAccess(role, session)) {
      return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
    }

    const getIpAddr = getIp(req);
    const getLimit = checkRateLimit("ops-get", getIpAddr, 60, 60);
    if (!getLimit.ok) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(getLimit.retryAfterSec) } }
      );
    }

    // Tab minimization: each response carries one grid only, so a tab can
    // never over-collect sibling domains. Unknown tabs are rejected;
    // company callers must name the tab (fail closed) except demo
    // session-less holders, who keep the full fictional payload (parity
    // with the demo walkthrough). Admin may omit the tab (back-compat).
    const { searchParams } = new URL(req.url);
    const tabParam = searchParams.get("tab");
    if (tabParam !== null && !(VALID_TABS as readonly string[]).includes(tabParam)) {
      return NextResponse.json({ error: "invalid_tab" }, { status: 400 });
    }
    const tab = tabParam as OperationsTab | null;
    const sessionCompany =
      session?.role === "company" && session.companyId ? session.companyId : null;
    if (role === "company" && tab === null && (sessionCompany !== null || !isDemoMode())) {
      return NextResponse.json({ error: "tab_required" }, { status: 400 });
    }

    const scopedCompanyId =
      session?.role === "company" && session.companyId
        ? session.companyId
        : null;

    await withTimeout(ensureAiOpsTables(), 15000, "operations schema check");
    const projectIdFilter = searchParams.get("projectId") ?? undefined;

    const demoTables = isDemoMode() ? getDemoTables() : null;
    const liveRowsPromise = demoTables
      ? null
      : withTimeout(
          Promise.all([
            db.select().from(companies).orderBy(desc(companies.createdAt)),
            db.select().from(projects).orderBy(desc(projects.createdAt)),
            db.select().from(milestones).orderBy(milestones.position),
            db.select().from(candidates).orderBy(candidates.rank),
            db.select().from(ndas).orderBy(desc(ndas.createdAt)),
            db.select().from(meetings).orderBy(desc(meetings.createdAt)),
            db.select().from(payments).orderBy(desc(payments.createdAt)),
            db.select().from(approvals).orderBy(desc(approvals.createdAt)),
            db.select().from(paymentProposals).orderBy(desc(paymentProposals.createdAt)),
            db.select().from(verificationRuns).orderBy(desc(verificationRuns.createdAt)),
            db.select().from(agentExecutions).orderBy(desc(agentExecutions.createdAt)),
            db.select().from(disputes).orderBy(desc(disputes.createdAt)),
          ]),
          15000,
          "operations queries"
        );
    const [
      rawCompanyRows,
      rawProjectRows,
      rawMilestoneRows,
      rawCandidateRows,
      rawNdaRows,
      rawMeetingRows,
      rawPaymentRows,
      approvalRows,
      proposalRows,
      verifRows,
      execRows,
      disputeRows,
    ] = demoTables
      ? [
          demoTables.companies,
          demoTables.projects,
          demoTables.milestones,
          demoTables.candidates,
          demoTables.ndas,
          demoTables.meetings,
          demoTables.payments,
          demoTables.approvals,
          demoTables.paymentProposals,
          demoTables.verificationRuns,
          demoTables.agentExecutions,
          demoTables.disputes,
        ]
      : await liveRowsPromise!;

    const companyRows = scopedCompanyId
      ? rawCompanyRows.filter((c) => c.id === scopedCompanyId)
      : rawCompanyRows;
    const projectRows = scopedCompanyId
      ? rawProjectRows.filter((p) => p.companyId === scopedCompanyId)
      : rawProjectRows;
    const allowedProjectIds = scopedCompanyId
      ? new Set(projectRows.map((p) => p.id))
      : null;
    const milestoneRows = allowedProjectIds
      ? rawMilestoneRows.filter((m) => allowedProjectIds.has(m.projectId))
      : rawMilestoneRows;
    const allowedMilestoneIds = allowedProjectIds
      ? new Set(milestoneRows.map((m) => m.id))
      : null;
    const candidateRows = allowedProjectIds
      ? rawCandidateRows.filter((c) => allowedProjectIds.has(c.projectId))
      : rawCandidateRows;
    const ndaRows = allowedProjectIds
      ? rawNdaRows.filter((n) => allowedProjectIds.has(n.projectId))
      : rawNdaRows;
    const meetingRows = allowedProjectIds
      ? rawMeetingRows.filter((m) => allowedProjectIds.has(m.projectId))
      : rawMeetingRows;
    const paymentRows = allowedMilestoneIds
      ? rawPaymentRows.filter((p) => p.milestoneId && allowedMilestoneIds.has(p.milestoneId))
      : rawPaymentRows;
    const allowedPaymentIds = allowedMilestoneIds
      ? new Set(paymentRows.map((p) => p.id))
      : null;
    const scopedApprovalRows = allowedPaymentIds
      ? approvalRows.filter((a) => allowedPaymentIds.has(a.paymentId))
      : approvalRows;
    const scopedProposalRows = allowedMilestoneIds
      ? proposalRows.filter((pp) => allowedMilestoneIds.has(pp.milestoneId))
      : proposalRows;
    const scopedVerifRows = allowedMilestoneIds
      ? verifRows.filter((vr) => allowedMilestoneIds.has(vr.milestoneId))
      : verifRows;
    const scopedExecRows = allowedProjectIds
      ? execRows.filter((e) => e.projectId !== null && allowedProjectIds.has(e.projectId))
      : execRows;
    const scopedDisputeRows = allowedMilestoneIds
      ? disputeRows.filter((d) => d.milestoneId && allowedMilestoneIds.has(d.milestoneId))
      : disputeRows;

    const companyMap = new Map(companyRows.map((c) => [c.id, c]));
    const projectMap = new Map(projectRows.map((p) => [p.id, p]));
    const candidateMap = new Map(candidateRows.map((c) => [c.id, c]));
    const milestoneMap = new Map(milestoneRows.map((m) => [m.id, m]));

    // 1. Consultants Grid Rows
    const consultantsGrid = candidateRows
      .filter((c) => !projectIdFilter || c.projectId === projectIdFilter)
      .map((c) => {
        const proj = projectMap.get(c.projectId);
        const rawScore = c.trustScore ? parseFloat(c.trustScore) : 0;
        const normalizedTrustScore =
          rawScore > 0 && rawScore <= 1 ? Math.round(rawScore * 100) : Math.round(rawScore);
        const canDoList = Array.isArray(c.canDo) ? c.canDo : [];
        const cannotDoList = Array.isArray(c.cannotDo) ? c.cannotDo : [];

        return {
          id: c.id,
          projectId: c.projectId,
          projectTitle: proj?.title ?? c.projectId,
          name: c.name,
          email: c.email,
          githubHandle: c.githubHandle ?? "—",
          portfolioUrl: c.portfolioUrl ?? null,
          trustScore: normalizedTrustScore,
          rank: c.rank ?? 99,
          status: c.status,
          verifiedSkillsCount: canDoList.length,
          gapsCount: cannotDoList.length,
          canDo: canDoList,
          cannotDo: cannotDoList,
          vettingSummary: c.vettingSummary ?? "Pending detailed vetting summary.",
          createdAt: c.createdAt.toISOString(),
        };
      });

    // 2. Projects Grid Rows
    const projectsGrid = projectRows
      .filter((p) => !projectIdFilter || p.id === projectIdFilter)
      .map((p) => {
        const comp = companyMap.get(p.companyId);
        const projMilestones = milestoneRows.filter((m) => m.projectId === p.id);
        const projCandidates = candidateRows.filter((c) => c.projectId === p.id);
        const totalPlannedUsd = projMilestones.reduce(
          (sum, m) => sum + parseFloat(m.budgetUsd || "0"),
          0
        );
        const fundedUsd = projMilestones
          .filter((m) => ["funded", "pending_approval", "verifying", "paid"].includes(m.status))
          .reduce((sum, m) => sum + parseFloat(m.captureGrossUsd || m.budgetUsd || "0"), 0);
        const paidUsd = projMilestones
          .filter((m) => m.status === "paid")
          .reduce((sum, m) => sum + parseFloat(m.budgetUsd || "0"), 0);

        return {
          id: p.id,
          title: p.title,
          companyId: p.companyId,
          companyName: comp?.name ?? p.companyId,
          status: p.status,
          githubRepoUrl: p.githubRepoUrl ?? "—",
          autoApproveThresholdUsd: parseFloat(p.autoApproveThresholdUsd || "500"),
          milestoneCount: projMilestones.length,
          candidateCount: projCandidates.length,
          totalBudgetUsd: Number(totalPlannedUsd.toFixed(2)),
          fundedUsd: Number(fundedUsd.toFixed(2)),
          paidUsd: Number(paidUsd.toFixed(2)),
          createdAt: p.createdAt.toISOString(),
        };
      });

    // 3. Tasks / Milestones Grid Rows (Synchronized with Bryntum Gantt)
    const tasksGrid = milestoneRows
      .filter((m) => !projectIdFilter || m.projectId === projectIdFilter)
      .map((m, idx) => {
        const proj = projectMap.get(m.projectId);
        const pred = m.dependsOnId ? milestoneMap.get(m.dependsOnId) : null;
        const isLocked = m.status === "funded" || m.status === "paid";
        const percentDone =
          m.status === "paid"
            ? 100
            : m.status === "verifying" || m.status === "pending_approval"
            ? 80
            : m.status === "submitted"
            ? 65
            : m.status === "funded"
            ? 40
            : 10;

        return {
          id: m.id,
          projectId: m.projectId,
          projectTitle: proj?.title ?? m.projectId,
          wbsCode: `1.${idx + 1}`,
          title: m.title,
          description: m.description ?? "",
          status: m.status,
          budgetUsd: parseFloat(m.budgetUsd || "0"),
          startDate: m.startDate ?? "—",
          dueDate: m.dueDate ?? "—",
          dependsOnId: m.dependsOnId ?? null,
          dependsOnTitle: pred?.title ?? "None",
          offsetDays: m.offsetDays ?? 0,
          percentDone,
          isLocked,
          version: m.version,
          position: m.position,
          // PayPal ids are emitted only on the payments tab (authorized
          // audience); the tasks tab never carries them.
        };
      });

    // 4. Companies Grid Rows
    const companiesGrid = companyRows.map((c) => {
      const compProjects = projectRows.filter((p) => p.companyId === c.id);
      const compProjectIds = new Set(compProjects.map((p) => p.id));
      const compMilestones = milestoneRows.filter((m) => compProjectIds.has(m.projectId));
      const totalContractedUsd = compMilestones.reduce(
        (sum, m) => sum + parseFloat(m.budgetUsd || "0"),
        0
      );

      return {
        id: c.id,
        name: c.name,
        email: c.email,
        paypalMerchantId: c.paypalMerchantId ?? "Sandbox Default",
        projectCount: compProjects.length,
        activeProjectCount: compProjects.filter((p) => p.status === "active").length,
        totalContractedUsd: Number(totalContractedUsd.toFixed(2)),
        createdAt: c.createdAt.toISOString(),
      };
    });

    // 5. Contracts Grid Rows (NDAs + Meetings)
    const contractsGrid = ndaRows
      .filter((n) => !projectIdFilter || n.projectId === projectIdFilter)
      .map((n) => {
        const cand = candidateMap.get(n.candidateId);
        const proj = projectMap.get(n.projectId);
        const meeting = meetingRows.find(
          (mt) => mt.candidateId === n.candidateId && mt.projectId === n.projectId
        );

        return {
          id: n.id,
          projectId: n.projectId,
          projectTitle: proj?.title ?? n.projectId,
          candidateId: n.candidateId,
          candidateName: cand?.name ?? n.candidateId,
          templateVersion: n.templateVersion ?? "v1.0-mutual-nda",
          status: n.status,
          acceptedName: n.acceptedName ?? "—",
          acceptedAt: n.acceptedAt?.toISOString() ?? null,
          documentHash: redactDocumentHash(n.documentHash ?? n.contentHash),
          meetingStatus: meeting?.status ?? "not_scheduled",
          meetingScheduledAt: meeting?.scheduledAt?.toISOString() ?? null,
          expiresAt: n.expiresAt?.toISOString() ?? null,
          createdAt: n.createdAt.toISOString(),
        };
      });

    // 6. Payments Grid Rows
    const paymentsGrid = paymentRows
      .filter((pay) => {
        if (!projectIdFilter) return true;
        const ms = milestoneMap.get(pay.milestoneId);
        return ms?.projectId === projectIdFilter;
      })
      .map((pay) => {
        const ms = milestoneMap.get(pay.milestoneId);
        const proj = ms ? projectMap.get(ms.projectId) : null;
        const cand = pay.candidateId ? candidateMap.get(pay.candidateId) : null;
        const approval = scopedApprovalRows.find((a) => a.paymentId === pay.id);
        const proposal = scopedProposalRows.find((pp) => pp.milestoneId === pay.milestoneId);

        return {
          id: pay.id,
          milestoneId: pay.milestoneId,
          milestoneTitle: ms?.title ?? pay.milestoneId,
          projectId: ms?.projectId ?? "—",
          projectTitle: proj?.title ?? "—",
          candidateName: cand?.name ?? "Assigned Consultant",
          candidateEmail: cand?.email ?? "—",
          grossUsd: parseFloat(pay.grossUsd || ms?.budgetUsd || "0"),
          feeUsd: parseFloat(pay.feeUsd || "0"),
          netUsd: parseFloat(pay.netUsd || ms?.captureNetUsd || ms?.budgetUsd || "0"),
          currency: pay.currency ?? "USD",
          status: pay.status,
          approvalStatus: approval?.decision ?? (proposal?.status ?? "not_required"),
          approvalId: approval?.id ?? null,
          decidedBy: approval?.decidedBy ?? proposal?.decidedBy ?? null,
          payoutFailureReason: pay.payoutFailureReason ?? null,
          paypalOrderId: pay.paypalOrderId ?? ms?.paypalOrderId ?? "—",
          paypalCaptureId: pay.paypalCaptureId ?? ms?.paypalCaptureId ?? "—",
          paypalPayoutBatchId: pay.paypalPayoutBatchId ?? ms?.paypalPayoutBatchId ?? "—",
          senderBatchId: pay.senderBatchId ?? `PAY_${pay.id}`,
          createdAt: pay.createdAt.toISOString(),
        };
      });

    // 7. Agent Executions Grid Rows
    const executionsGrid = [
      ...scopedExecRows.map((e) => ({
        id: e.id,
        source: "supervisor_orchestrator",
        projectId: e.projectId ?? "—",
        intent: e.intent,
        userRequest: e.userRequest,
        delegatedAgents: Array.isArray(e.delegatedAgents)
          ? (e.delegatedAgents as string[]).join(", ")
          : "supervisor_agent",
        status: e.status,
        approvalStatus: e.approvalStatus,
        totalTokens: e.totalTokens,
        durationMs: e.durationMs,
        retryCount: e.retryCount,
        requestedBy: e.requestedBy,
        decidedBy: e.decidedBy ?? "—",
        finalResult: e.finalResult,
        createdAt: e.createdAt.toISOString(),
      })),
      ...scopedVerifRows.map((vr) => {
        const ms = milestoneMap.get(vr.milestoneId);
        return {
          id: vr.id,
          source: "delivery_verification_pipeline",
          projectId: ms?.projectId ?? "—",
          intent: "delivery_verification",
          userRequest: `Verify PR #${vr.prNumber} (${vr.prOwner}/${vr.prRepo})`,
          delegatedAgents: "delivery_agent, finance_agent",
          status: vr.status,
          approvalStatus: vr.policyDecision ?? "completed",
          totalTokens: 0,
          durationMs: vr.durationMs ?? 0,
          retryCount: 0,
          requestedBy: vr.submittedBy ?? "github_webhook",
          decidedBy: "policy_engine",
          finalResult: vr.justification ?? `PR #${vr.prNumber} evaluated (${vr.policyDecision})`,
          createdAt: vr.createdAt.toISOString(),
        };
      }),
    ];

    const grids = {
      consultants: consultantsGrid,
      projects: projectsGrid,
      tasks: tasksGrid,
      companies: companiesGrid,
      contracts: contractsGrid,
      payments: paymentsGrid,
      executions: executionsGrid,
    };
    if (tab === null) {
      return NextResponse.json({
        ...grids,
        disputesCount: scopedDisputeRows.length,
      });
    }
    if (tab === "companies") {
      return NextResponse.json({
        tab,
        companies: grids.companies,
        disputesCount: scopedDisputeRows.length,
      });
    }
    return NextResponse.json({ tab, [tab]: grids[tab] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/operations/data GET] Error:", message);
    // Honest service state: the grids must show an error, not empty data.
    return NextResponse.json(
      { error: message, status: "unavailable" },
      { status: 503 }
    );
  }
}

/**
 * PATCH /api/operations/data
 * Inline editing handler for AG Grid cells with validation and audit logging.
 * Synchronizes task/milestone changes directly with the shared database used by Bryntum Gantt.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const patchCookieHeader = req.headers.get("cookie") ?? null;
    const patchSession = await getSessionFromCookie(patchCookieHeader);
    const role = patchSession?.role ?? (await getRoleFromCookie(patchCookieHeader));
    // Server-side authorization: company/admin only. The freelancer role is
    // read-only and unauthenticated traffic cannot mutate.
    if (role !== "company" && role !== "admin") {
      return NextResponse.json(
        { error: "Forbidden: editing operations requires the company or admin role." },
        { status: 403 }
      );
    }

    // Live mode: company callers need a verified session (D.3 — a bare role
    // cookie must never authorize company mutations).
    if (!companySessionAllowsLiveAccess(role, patchSession)) {
      return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
    }

    const patchIp = getIp(req);
    const patchLimit = checkRateLimit("ops-patch", patchIp, 60, 60);
    if (!patchLimit.ok) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(patchLimit.retryAfterSec) } }
      );
    }

    const body = await req.json().catch(() => null);
    const entity = body?.entity as "task" | "consultant" | "project" | undefined;
    const id = body?.id as string | undefined;
    const updates = body?.updates as Record<string, unknown> | undefined;

    if (!entity || !id || !updates ||
        (entity !== "task" && entity !== "consultant" && entity !== "project") ||
        typeof id !== "string" || id.length > 100 ||
        typeof updates !== "object" || Array.isArray(updates)) {
      return NextResponse.json(
        { error: "entity, id, and updates are required." },
        { status: 400 }
      );
    }
    const patchActor = patchSession
      ? `${patchSession.role}:${patchSession.userId}`
      : `${role ?? "company"}-operator`;

    if (isDemoMode()) {
      const { getDemoTables } = await import("@/lib/demo/store");
      const t = getDemoTables();
      if (entity === "task") {
        const existing = t.milestones.find((m) => m.id === id);
        if (!existing) {
          return NextResponse.json({ error: "Task/Milestone not found." }, { status: 404 });
        }
        if (patchSession?.role === "company" && patchSession.companyId) {
          const demoProject = t.projects.find((p) => p.id === existing.projectId);
          if (!demoProject || demoProject.companyId !== patchSession.companyId) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
        }
        if (
          (existing.status === "funded" || existing.status === "paid") &&
          (updates.startDate !== undefined || updates.dueDate !== undefined || updates.budgetUsd !== undefined)
        ) {
          return NextResponse.json(
            { error: `Task '${existing.title}' is in '${existing.status}' status and is financially locked.` },
            { status: 409 }
          );
        }
        if (typeof updates.title === "string" && updates.title.trim().length > 0) {
          existing.title = updates.title.trim();
        }
        if (typeof updates.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(updates.startDate)) {
          existing.startDate = updates.startDate;
        }
        if (typeof updates.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(updates.dueDate)) {
          existing.dueDate = updates.dueDate;
        }
        if (updates.budgetUsd !== undefined) {
          const num = Number(updates.budgetUsd);
          if (!Number.isFinite(num) || num <= 0) {
            return NextResponse.json({ error: "budgetUsd must be a positive number." }, { status: 400 });
          }
          existing.budgetUsd = num.toFixed(2);
        }
        existing.version += 1;
        existing.updatedAt = new Date();
        await writeAuditLog({
          entityType: "milestone",
          entityId: id,
          event: "AG_GRID_INLINE_TASK_UPDATED",
          actor: patchActor,
          payload: updates,
        });
        return NextResponse.json({ ok: true, entity, id, updates, simulated: true });
      }
      if (entity === "consultant") {
        const existing = t.candidates.find((c) => c.id === id);
        if (!existing) {
          return NextResponse.json({ error: "Consultant not found." }, { status: 404 });
        }
        if (patchSession?.role === "company" && patchSession.companyId) {
          const demoProject = t.projects.find((p) => p.id === existing.projectId);
          if (!demoProject || demoProject.companyId !== patchSession.companyId) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
        }
        const validated = validateConsultantUpdates(updates);
        if (validated.error) {
          return NextResponse.json({ error: validated.error }, { status: 400 });
        }
        if (validated.rank !== undefined) existing.rank = validated.rank;
        if (validated.status !== undefined) {
          existing.status = validated.status as typeof existing.status;
        }
        existing.updatedAt = new Date();
        await writeAuditLog({
          entityType: "candidate",
          entityId: id,
          event: "AG_GRID_INLINE_CONSULTANT_UPDATED",
          actor: patchActor,
          payload: updates,
        });
        return NextResponse.json({ ok: true, entity, id, updates, simulated: true });
      }
      if (entity === "project") {
        const existing = t.projects.find((p) => p.id === id);
        if (!existing) {
          return NextResponse.json({ error: "Project not found." }, { status: 404 });
        }
        if (patchSession?.role === "company" && patchSession.companyId &&
            existing.companyId !== patchSession.companyId) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        if (typeof updates.title === "string" && updates.title.trim().length > 0) {
          existing.title = updates.title.trim();
        }
        if (updates.autoApproveThresholdUsd !== undefined) {
          const num = Number(updates.autoApproveThresholdUsd);
          if (Number.isFinite(num) && num >= 0) {
            existing.autoApproveThresholdUsd = num.toFixed(2);
          }
        }
        existing.updatedAt = new Date();
        await writeAuditLog({
          entityType: "project",
          entityId: id,
          event: "AG_GRID_INLINE_PROJECT_UPDATED",
          actor: patchActor,
          payload: updates,
        });
        return NextResponse.json({ ok: true, entity, id, updates, simulated: true });
      }
      return NextResponse.json({ error: "Unsupported entity type." }, { status: 400 });
    }

    if (entity === "task") {
      const [existing] = await db
        .select()
        .from(milestones)
        .where(eq(milestones.id, id))
        .limit(1);

      if (!existing) {
        return NextResponse.json({ error: "Task/Milestone not found." }, { status: 404 });
      }

      if (patchSession?.role === "company" && patchSession.companyId) {
        const [taskProject] = await db
          .select({ companyId: projects.companyId })
          .from(projects)
          .where(eq(projects.id, existing.projectId))
          .limit(1);
        if (!taskProject || taskProject.companyId !== patchSession.companyId) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }

      if (
        (existing.status === "funded" || existing.status === "paid") &&
        (updates.startDate !== undefined || updates.dueDate !== undefined || updates.budgetUsd !== undefined)
      ) {
        return NextResponse.json(
          {
            error: `Task '${existing.title}' is in '${existing.status}' status and is financially locked.`,
          },
          { status: 409 }
        );
      }

      const patchValues: Record<string, unknown> = {
        version: sql`${milestones.version} + 1`,
        updatedAt: new Date(),
      };

      if (typeof updates.title === "string" && updates.title.trim().length > 0) {
        patchValues.title = updates.title.trim();
      }
      if (typeof updates.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(updates.startDate)) {
        patchValues.startDate = updates.startDate;
      }
      if (typeof updates.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(updates.dueDate)) {
        patchValues.dueDate = updates.dueDate;
      }
      if (updates.budgetUsd !== undefined) {
        const num = Number(updates.budgetUsd);
        if (!Number.isFinite(num) || num <= 0) {
          return NextResponse.json(
            { error: "budgetUsd must be a positive number." },
            { status: 400 }
          );
        }
        patchValues.budgetUsd = num.toFixed(2);
      }

      await db.update(milestones).set(patchValues).where(eq(milestones.id, id));

      await writeAuditLog({
        entityType: "milestone",
        entityId: id,
        event: "AG_GRID_INLINE_TASK_UPDATED",
        actor: patchActor,
        payload: updates,
      });

      return NextResponse.json({ ok: true, entity, id, updates });
    }

    if (entity === "consultant") {
      if (patchSession?.role === "company" && patchSession.companyId) {
        const [consultantRow] = await db
          .select({ projectId: candidates.projectId })
          .from(candidates)
          .where(eq(candidates.id, id))
          .limit(1);
        const [consultantProject] = consultantRow
          ? await db
              .select({ companyId: projects.companyId })
              .from(projects)
              .where(eq(projects.id, consultantRow.projectId))
              .limit(1)
          : [];
        if (!consultantRow || !consultantProject ||
            consultantProject.companyId !== patchSession.companyId) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
      const validated = validateConsultantUpdates(updates);
      if (validated.error) {
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }
      const patchValues: Record<string, unknown> = { updatedAt: new Date() };
      if (validated.rank !== undefined) patchValues.rank = validated.rank;
      if (validated.status !== undefined) patchValues.status = validated.status;

      await db.update(candidates).set(patchValues).where(eq(candidates.id, id));

      await writeAuditLog({
        entityType: "candidate",
        entityId: id,
        event: "AG_GRID_INLINE_CONSULTANT_UPDATED",
        actor: patchActor,
        payload: updates,
      });

      return NextResponse.json({ ok: true, entity, id, updates });
    }

    if (entity === "project") {
      if (patchSession?.role === "company" && patchSession.companyId) {
        const [projectRow] = await db
          .select({ companyId: projects.companyId })
          .from(projects)
          .where(eq(projects.id, id))
          .limit(1);
        if (!projectRow || projectRow.companyId !== patchSession.companyId) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
      const patchValues: Record<string, unknown> = { updatedAt: new Date() };
      if (typeof updates.title === "string" && updates.title.trim().length > 0) {
        patchValues.title = updates.title.trim();
      }
      if (updates.autoApproveThresholdUsd !== undefined) {
        const num = Number(updates.autoApproveThresholdUsd);
        if (Number.isFinite(num) && num >= 0) {
          patchValues.autoApproveThresholdUsd = num.toFixed(2);
        }
      }

      await db.update(projects).set(patchValues).where(eq(projects.id, id));

      await writeAuditLog({
        entityType: "project",
        entityId: id,
        event: "AG_GRID_INLINE_PROJECT_UPDATED",
        actor: patchActor,
        payload: updates,
      });

      return NextResponse.json({ ok: true, entity, id, updates });
    }

    return NextResponse.json({ error: "Unsupported entity type." }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/operations/data PATCH] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
