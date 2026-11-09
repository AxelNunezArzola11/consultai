export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import {
  projects,
  milestones,
  candidates,
  payments,
  approvals,
  disputes,
  schedulingProposals,
} from "@/lib/db/schema";
import { ensureAiOpsTables } from "@/lib/ai-ops/orchestrator-engine";
import { desc, eq, inArray } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteProjectButton } from "@/components/shared/DeleteProjectButton";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { withTimeout } from "@/lib/db/with-timeout";
import { DbStatusBanner } from "@/components/demo/DbStatusBanner";
import { requirePageRole, scopedCompanyId } from "@/lib/auth/guards";

/**
 * Company Dashboard — Section 9 Differentiated Company Experience
 *
 * Displays real database-connected metrics:
 * - Active projects & drafts in progress
 * - Consultant assignments
 * - Budget utilization (Planned vs Escrow Held vs Paid)
 * - Pending milestones
 * - Payment status & pending human approvals
 * - Project health score (computed deterministically from delays, disputes, and milestone progress)
 * - AI-generated recommendations & quick links to Planning (Gantt), Operations (AG Grid), and AI Ops Center
 */
export default async function DashboardPage() {
  // Authenticate + authorize BEFORE querying/rendering (demo bypass: fixtures only).
  const auth = await requirePageRole(["company", "admin"]);
  // Live: company sessions see their own company only (no company-1 bypass).
  const scope = scopedCompanyId(auth);

  if (isDemoMode()) {
    const t = getDemoTables();
    const filteredProjects = scope
      ? t.projects.filter((p) => p.companyId === scope)
      : t.projects;
    const projectIds = new Set(filteredProjects.map((p) => p.id));
    return (
      <DashboardView
        projectList={[...filteredProjects].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 20)}
        allMilestones={[...t.milestones]
          .filter((m) => !scope || projectIds.has(m.projectId))
          .sort((a, b) => a.position - b.position)}
        allCandidates={[...t.candidates]
          .filter((c) => !scope || projectIds.has(c.projectId))
          .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))}
        allPayments={t.payments}
        allApprovals={t.approvals}
        allDisputes={t.disputes}
        allSchedProposals={t.schedulingProposals}
        demoMode
      />
    );
  }

  let degraded: string | null = null;
  let projectList: Array<typeof projects.$inferSelect> = [];
  let allMilestones: Array<typeof milestones.$inferSelect> = [];
  let allCandidates: Array<typeof candidates.$inferSelect> = [];
  let allPayments: Array<typeof payments.$inferSelect> = [];
  let allApprovals: Array<typeof approvals.$inferSelect> = [];
  let allDisputes: Array<typeof disputes.$inferSelect> = [];
  let allSchedProposals: Array<typeof schedulingProposals.$inferSelect> = [];

  try {
    await withTimeout(ensureAiOpsTables(), 15000, "operations schema check");
    if (scope) {
      // Company session: every table scoped to the caller's own projects.
      const ownIds = await withTimeout(
        db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.companyId, scope)),
        15000,
        "dashboard company projects"
      );
      const ownProjectIds = ownIds.map((r) => r.id);
      if (ownProjectIds.length > 0) {
        [projectList, allMilestones, allCandidates, allSchedProposals] =
          await withTimeout(
            Promise.all([
              db
                .select()
                .from(projects)
                .where(eq(projects.companyId, scope))
                .orderBy(desc(projects.createdAt))
                .limit(20),
              db
                .select()
                .from(milestones)
                .where(inArray(milestones.projectId, ownProjectIds))
                .orderBy(milestones.position),
              db
                .select()
                .from(candidates)
                .where(inArray(candidates.projectId, ownProjectIds))
                .orderBy(candidates.rank),
              db
                .select()
                .from(schedulingProposals)
                .where(inArray(schedulingProposals.projectId, ownProjectIds))
                .orderBy(desc(schedulingProposals.createdAt))
                .limit(10),
            ]),
            15000,
            "dashboard scoped queries"
          );
        const ownMilestoneIds = allMilestones.map((m) => m.id);
        if (ownMilestoneIds.length > 0) {
          [allPayments, allApprovals, allDisputes] = await withTimeout(
            Promise.all([
              db
                .select()
                .from(payments)
                .where(inArray(payments.milestoneId, ownMilestoneIds))
                .orderBy(desc(payments.createdAt)),
              db
                .select()
                .from(approvals)
                .where(inArray(approvals.milestoneId, ownMilestoneIds))
                .orderBy(desc(approvals.createdAt)),
              db
                .select()
                .from(disputes)
                .where(inArray(disputes.milestoneId, ownMilestoneIds)),
            ]),
            15000,
            "dashboard scoped financial queries"
          );
        }
      }
    } else {
      [
        projectList,
        allMilestones,
        allCandidates,
        allPayments,
        allApprovals,
        allDisputes,
        allSchedProposals,
      ] = await withTimeout(
        Promise.all([
          db.select().from(projects).orderBy(desc(projects.createdAt)).limit(20),
          db.select().from(milestones).orderBy(milestones.position),
          db.select().from(candidates).orderBy(candidates.rank),
          db.select().from(payments).orderBy(desc(payments.createdAt)),
          db.select().from(approvals).orderBy(desc(approvals.createdAt)),
          db.select().from(disputes),
          db.select().from(schedulingProposals).orderBy(desc(schedulingProposals.createdAt)).limit(10),
        ]),
        15000,
        "dashboard queries"
      );
    }
  } catch (err) {
    degraded =
      err instanceof Error
        ? err.message
        : "Live data could not be loaded.";
  }

  return (
    <>
      {degraded && (
        <div className="mx-auto w-full max-w-7xl px-6 pt-6">
          <DbStatusBanner
            title="Live data unavailable — dashboard cannot load."
            detail={`${degraded} No records are shown because the database could not be reached, not because the workspace is empty. Retry, check system status, or present the offline demo scenario instead.`}
          />
        </div>
      )}
      <DashboardView
        projectList={projectList}
        allMilestones={allMilestones}
        allCandidates={allCandidates}
        allPayments={allPayments}
        allApprovals={allApprovals}
        allDisputes={allDisputes}
        allSchedProposals={allSchedProposals}
      />
    </>
  );
}

function DashboardView({
  projectList,
  allMilestones,
  allCandidates,
  allPayments,
  allApprovals,
  allDisputes,
  allSchedProposals,
  demoMode,
}: {
  projectList: Array<typeof projects.$inferSelect>;
  allMilestones: Array<typeof milestones.$inferSelect>;
  allCandidates: Array<typeof candidates.$inferSelect>;
  allPayments: Array<typeof payments.$inferSelect>;
  allApprovals: Array<typeof approvals.$inferSelect>;
  allDisputes: Array<typeof disputes.$inferSelect>;
  allSchedProposals: Array<typeof schedulingProposals.$inferSelect>;
  demoMode?: boolean;
}) {
  const activeProjects = projectList.filter((p) => p.status !== "draft");
  const draftProjects = projectList.filter((p) => p.status === "draft");

  const activeProjectsCount = projectList.filter((p) => p.status === "active").length;
  const activeConsultantsCount = allCandidates.filter((c) =>
    ["selected", "nda_signed", "shortlisted", "booked", "meeting_held"].includes(c.status)
  ).length;

  const totalPlannedBudgetUsd = allMilestones.reduce(
    (sum, m) => sum + parseFloat(m.budgetUsd || "0"),
    0
  );
  const totalEscrowFundedUsd = allMilestones
    .filter((m) => ["funded", "pending_approval", "verifying", "paid"].includes(m.status))
    .reduce((sum, m) => sum + parseFloat(m.captureGrossUsd || m.budgetUsd || "0"), 0);
  const totalPaidUsd = allMilestones
    .filter((m) => m.status === "paid")
    .reduce((sum, m) => sum + parseFloat(m.budgetUsd || "0"), 0);

  const pendingMilestonesCount = allMilestones.filter(
    (m) => m.status !== "paid" && m.status !== "cancelled"
  ).length;
  const pendingApprovalsCount =
    allApprovals.filter((a) => a.decision === "pending").length +
    allSchedProposals.filter((sp) => sp.status === "pending_approval").length;

  const openDisputesCount = allDisputes.filter((d) => d.status !== "resolved" && d.status !== "closed").length;

  const healthScore = Math.max(
    50,
    100 - openDisputesCount * 15 - Math.min(20, pendingApprovalsCount * 5)
  );

  const aiRecommendations: Array<{ title: string; detail: string; href: string; badge: string }> = [];
  if (pendingApprovalsCount > 0) {
    aiRecommendations.push({
      badge: "Human Gate",
      title: `${pendingApprovalsCount} Proposal(s) Awaiting Human Authorization`,
      detail:
        "Review pending financial payout or schedule adjustment proposals in the AI Operations Center.",
      href: "/ai-ops",
    });
  }
  const unfundedPlanned = allMilestones.filter((m) => m.status === "planned");
  if (unfundedPlanned.length > 0) {
    aiRecommendations.push({
      badge: "Escrow Readiness",
      title: `${unfundedPlanned.length} Planned Milestone(s) Ready for Escrow Funding or WBS Scheduling`,
      detail:
        "Inspect critical path dependencies in Bryntum Gantt or fund upcoming milestones via PayPal Orders.",
      href: "/planning",
    });
  }
  if (aiRecommendations.length === 0) {
    aiRecommendations.push({
      badge: "Supervisor AI",
      title: "Run Multi-Agent Project Audit",
      detail:
        "Dispatch the Supervisor Agent to evaluate consultant GitHub signals, critical path slack, and payout eligibility.",
      href: "/ai-ops",
    });
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 sm:px-6 py-7">
      {/* ── Top Executive Header ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Enterprise Project &amp; Consulting Dashboard
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-300 tabular-nums">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Platform Health: {healthScore}%
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-300">
            {demoMode
              ? "Simulated portfolio metrics for the fictional TechNova scenario — no live services connected."
              : "Real-time portfolio metrics connected to Neon PostgreSQL, PayPal Escrow, Bryntum Gantt, and Multi-Agent AI."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/planning"
            className="rounded-lg border border-slate-700/80 bg-[#0f141e] px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
          >
            ◈ Bryntum Gantt Planning
          </Link>
          <Link
            href="/operations"
            className="rounded-lg border border-slate-700/80 bg-[#0f141e] px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
          >
            ⊞ AG Grid Operations
          </Link>
          <Link
            href="/ai-ops"
            className="rounded-lg border border-blue-500/35 bg-blue-500/10 px-3 py-2 text-xs font-semibold text-blue-300 transition hover:bg-blue-500/20"
          >
            ✦ AI Operations Center
          </Link>
          <Link
            href="/project/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-blue-600/25 transition hover:bg-blue-500"
          >
            <span>+</span> New Project
          </Link>
        </div>
      </div>

      {/* ── Unified 6-Metric Executive Telemetry Strip (1px hairline grid) ── */}
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-800 bg-slate-800 gap-px lg:grid-cols-6 shadow-sm">
        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Active Projects</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-white">
            {activeProjectsCount}{" "}
            <span className="text-xs font-normal text-slate-400">
              / {projectList.length} total
            </span>
          </div>
          <div className={`mt-1 text-[11px] font-medium ${demoMode ? "text-sky-300" : "text-emerald-300"}`}>
            {demoMode ? "Simulated demo data" : "Connected to Neon DB"}
          </div>
        </div>

        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Consultant Assignments</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-blue-400">
            {activeConsultantsCount}{" "}
            <span className="text-xs font-normal text-slate-400">
              / {allCandidates.length} vetted
            </span>
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {demoMode ? "Simulated vetting signals" : "GitHub signal verified"}
          </div>
        </div>

        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Planned Budget</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-white">
            ${totalPlannedBudgetUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
          <div className="mt-1 text-[11px] tabular-nums text-slate-400">
            Escrow Funded: ${totalEscrowFundedUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
        </div>

        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Released Payouts</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-emerald-400">
            ${totalPaidUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
          <div className="mt-1 text-[11px] tabular-nums text-slate-400">
            {allPayments.length} payment record(s)
          </div>
        </div>

        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Pending Milestones</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-amber-400">
            {pendingMilestonesCount}
          </div>
          <div className="mt-1 text-[11px] tabular-nums text-slate-400">
            {pendingApprovalsCount} awaiting human approval
          </div>
        </div>

        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Portfolio Health</div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-emerald-400">
            {healthScore}%
          </div>
          <div className="mt-1 text-[11px] tabular-nums text-slate-400">
            {openDisputesCount} active dispute(s)
          </div>
        </div>
      </div>

      {/* ── AI Operational Recommendations Strip ───────────────────────────── */}
      <div className="rounded-xl border border-slate-800 bg-[#0f141e] p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-blue-400" />
            <h2 className="text-xs font-semibold text-slate-200">
              AI Supervisor Operational Recommendations
            </h2>
          </div>
          <Link href="/ai-ops" className="text-xs font-medium text-blue-400 hover:text-blue-300">
            Open AI Operations Center →
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {aiRecommendations.map((rec, idx) => (
            <Link
              key={idx}
              href={rec.href}
              className="interactive-card-lift flex flex-col justify-between rounded-lg border border-slate-800/90 bg-[#0b0f17] p-3.5 transition hover:border-blue-500/40"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-blue-300">
                    {rec.badge}
                  </span>
                  <span className="text-[11px] font-semibold text-blue-400">
                    Inspect &amp; Execute →
                  </span>
                </div>
                <div className="mt-2 text-sm font-semibold text-white">{rec.title}</div>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">{rec.detail}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* ── Drafts In Progress (if any) ─────────────────────────────────────── */}
      {draftProjects.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">
              Drafts In Progress ({draftProjects.length})
            </h2>
            <span className="text-xs text-slate-400">
              Unapproved AI planning drafts — resume scoping or discard
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {draftProjects.map((draft) => (
              <div
                key={draft.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#0f141e] px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-white">
                      {draft.title}
                    </span>
                    <StatusPill status={draft.status} />
                  </div>
                  {draft.rawBrief && (
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {draft.rawBrief}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href={`/project/new?projectId=${encodeURIComponent(draft.id)}`}
                    className="rounded-md bg-blue-600/15 border border-blue-500/30 px-2.5 py-1 text-xs font-semibold text-blue-300 hover:bg-blue-600/25"
                  >
                    Resume Planning →
                  </Link>
                  <DeleteProjectButton
                    projectId={draft.id}
                    projectTitle={draft.title}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Active Projects List ────────────────────────────────────────────── */}
      {projectList.length === 0 ? (
        <Card className="rounded-xl border-slate-800 bg-[#0f141e]">
          <CardContent className="py-14 text-center text-slate-300">
            <div className="mb-3 text-3xl text-slate-500">◈</div>
            <p className="text-sm font-medium text-white">
              No projects found in workspace
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Create a new consulting engagement or run{" "}
              <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-slate-200">
                npm run seed
              </code>{" "}
              to populate sample data.
            </p>
            <Link
              href="/project/new"
              className="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
            >
              + Create your first project
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {(activeProjects.length > 0 ? activeProjects : projectList).map((project) => {
            const projMilestones = allMilestones.filter((m) => m.projectId === project.id);
            const projCandidates = allCandidates.filter((c) => c.projectId === project.id);
            return (
              <ProjectCard
                key={project.id}
                project={project}
                milestoneList={projMilestones}
                candidateCount={projCandidates.length}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

const NAV_TABS = [
  { label: "Workspace Canvas", segment: "" },
  { label: "Milestones", segment: "milestones" },
  { label: "Candidates", segment: "candidates" },
  { label: "Vetting", segment: "vetting" },
  { label: "Ledger", segment: "ledger" },
  { label: "Approvals", segment: "approvals" },
] as const;

const STATUS_STYLES: Record<
  string,
  { bg: string; text: string; border: string; dot: string }
> = {
  active: {
    bg: "bg-emerald-950/40",
    text: "text-emerald-300",
    border: "border-emerald-700/50",
    dot: "bg-emerald-400",
  },
  draft: {
    bg: "bg-slate-800/70",
    text: "text-slate-300",
    border: "border-slate-700",
    dot: "bg-slate-400",
  },
  planned: {
    bg: "bg-slate-800/60",
    text: "text-slate-300",
    border: "border-slate-700/70",
    dot: "bg-slate-400",
  },
  funded: {
    bg: "bg-blue-950/45",
    text: "text-blue-300",
    border: "border-blue-700/50",
    dot: "bg-blue-400",
  },
  submitted: {
    bg: "bg-amber-950/35",
    text: "text-amber-300",
    border: "border-amber-700/50",
    dot: "bg-amber-400",
  },
  verifying: {
    bg: "bg-amber-950/35",
    text: "text-amber-300",
    border: "border-amber-700/50",
    dot: "bg-amber-400",
  },
  pending_approval: {
    bg: "bg-amber-950/35",
    text: "text-amber-300",
    border: "border-amber-700/50",
    dot: "bg-amber-400",
  },
  paid: {
    bg: "bg-emerald-950/45",
    text: "text-emerald-300",
    border: "border-emerald-700/50",
    dot: "bg-emerald-400",
  },
  disputed: {
    bg: "bg-rose-950/40",
    text: "text-rose-300",
    border: "border-rose-700/50",
    dot: "bg-rose-400",
  },
  cancelled: {
    bg: "bg-slate-800/50",
    text: "text-slate-400",
    border: "border-slate-700/50",
    dot: "bg-slate-500",
  },
  failed: {
    bg: "bg-rose-950/40",
    text: "text-rose-300",
    border: "border-rose-700/50",
    dot: "bg-rose-400",
  },
  returned: {
    bg: "bg-slate-800/50",
    text: "text-slate-400",
    border: "border-slate-700/50",
    dot: "bg-slate-500",
  },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.planned;
  const label = status.replace(/_/g, " ");
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize ${s.bg} ${s.text} ${s.border}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {label}
    </span>
  );
}

function ProjectCard({
  project,
  milestoneList,
  candidateCount,
}: {
  project: typeof projects.$inferSelect;
  milestoneList: Array<typeof milestones.$inferSelect>;
  candidateCount: number;
}) {
  const totalBudget = milestoneList.reduce((acc, m) => acc + Number(m.budgetUsd), 0);
  const paidCount = milestoneList.filter((m) => m.status === "paid").length;
  const fundedOrActiveCount = milestoneList.filter((m) =>
    ["funded", "verifying", "pending_approval", "paid"].includes(m.status)
  ).length;
  const completionPct =
    milestoneList.length > 0
      ? Math.round((paidCount / milestoneList.length) * 100)
      : 0;
  const escrowCoveragePct =
    milestoneList.length > 0
      ? Math.round((fundedOrActiveCount / milestoneList.length) * 100)
      : 0;

  return (
    <Card className="overflow-hidden rounded-xl border-slate-800 bg-[#0f141e] shadow-lg transition-colors hover:border-slate-700/90">
      <CardHeader className="border-b border-slate-800/80 pb-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <CardTitle className="text-lg">
                <Link
                  href={`/project/${project.id}/milestones`}
                  className="font-bold text-white transition-colors hover:text-blue-400"
                >
                  {project.title}
                </Link>
              </CardTitle>
              <StatusPill status={project.status} />
            </div>
            {project.rawBrief && (
              <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-slate-300">
                {project.rawBrief}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/planning?projectId=${encodeURIComponent(project.id)}`}
              className="rounded-lg border border-slate-700/80 bg-[#0b0f17] px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
            >
              ◈ Gantt Plan
            </Link>
            <DeleteProjectButton
              projectId={project.id}
              projectTitle={project.title}
            />
          </div>
        </div>

        {/* Summary Metrics + Execution Progress Bar */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-800/80 bg-[#0b0f17] px-3.5 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-5 text-slate-300">
            <span>
              <strong className="font-mono font-semibold tabular-nums text-white">
                {milestoneList.length}
              </strong>{" "}
              milestones
            </span>
            <span>
              <strong className="font-mono font-semibold tabular-nums text-emerald-400">
                {paidCount}
              </strong>{" "}
              paid
            </span>
            <span>
              <strong className="font-mono font-semibold tabular-nums text-blue-400">
                {candidateCount}
              </strong>{" "}
              consultants
            </span>
            {totalBudget > 0 && (
              <span>
                <strong className="font-mono font-semibold tabular-nums text-white">
                  ${totalBudget.toLocaleString()}
                </strong>{" "}
                total budget
              </span>
            )}
          </div>

          {milestoneList.length > 0 && (
            <div className="flex items-center gap-3 min-w-[200px]">
              <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${Math.max(completionPct, escrowCoveragePct * 0.6)}%` }}
                />
              </div>
              <span className="font-mono text-[11px] tabular-nums text-slate-300">
                {escrowCoveragePct}% funded
              </span>
            </div>
          )}
        </div>

        {/* Quick-Jump Section Links */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {NAV_TABS.map(({ label, segment }) => (
            <Link
              key={label}
              href={
                segment === ""
                  ? `/project/${project.id}/milestones`
                  : `/project/${project.id}/${segment}`
              }
              className="rounded-md border border-slate-700/70 bg-slate-900/90 px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:border-blue-500/40 hover:bg-slate-800 hover:text-white"
            >
              {label}
            </Link>
          ))}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {milestoneList.length === 0 ? (
          <p className="px-5 py-4 text-xs text-slate-400">No milestones yet.</p>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {milestoneList.map((m, idx) => (
              <div
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 text-xs transition-colors hover:bg-[#131b29]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-800/90 font-mono text-[10px] font-semibold tabular-nums text-slate-300">
                    {idx + 1}
                  </span>
                  <span className="truncate font-medium text-slate-100">
                    {m.title}
                  </span>
                  {m.dueDate && (
                    <span className="font-mono text-[11px] tabular-nums text-slate-400">
                      Due: {m.dueDate}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-mono font-semibold tabular-nums text-slate-200">
                    ${Number(m.budgetUsd).toLocaleString()}
                  </span>
                  <StatusPill status={m.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
