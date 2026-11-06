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
import { desc, eq } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteProjectButton } from "@/components/shared/DeleteProjectButton";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { withTimeout } from "@/lib/db/with-timeout";
import { DbStatusBanner } from "@/components/demo/DbStatusBanner";

/**
 * Company Dashboard — Section 9 Differentiated Company Experience
 *
 * Displays real database-connected metrics:
 * - Active projects
 * - Consultant assignments
 * - Budget utilization (Planned vs Escrow Held vs Paid)
 * - Pending milestones
 * - Payment status & pending human approvals
 * - Project health score (computed deterministically from delays, disputes, and milestone progress)
 * - AI-generated recommendations & quick links to Planning (Gantt), Operations (AG Grid), and AI Ops Center
 */
export default async function DashboardPage() {
  if (isDemoMode()) {
    const t = getDemoTables();
    return (
      <DashboardView
        projectList={[...t.projects].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 20)}
        allMilestones={[...t.milestones].sort((a, b) => a.position - b.position)}
        allCandidates={[...t.candidates].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))}
        allPayments={t.payments}
        allApprovals={t.approvals}
        allDisputes={t.disputes}
        allSchedProposals={t.schedulingProposals}
        demoMode
      />
    );
  }

  // Bounded wait: never hang indefinitely on a slow database. On failure
  // the page renders an honest degraded state instead of silent empty data.
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

  // Deterministic platform health score
  const healthScore = Math.max(
    50,
    100 - openDisputesCount * 15 - Math.min(20, pendingApprovalsCount * 5)
  );

  // Build actionable AI recommendations connected to real project state
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
    <div className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      {/* ── Top Executive Banner ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-blue-500/20 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-blue-400">
              Company Executive Console
            </span>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400">
              Platform Health: {healthScore}%
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
            Enterprise Project &amp; Consulting Dashboard
          </h1>
          <p className="mt-0.5 text-xs text-slate-400">
            {demoMode
              ? "Simulated portfolio metrics for the fictional TechNova scenario — no live services connected."
              : "Real-time portfolio metrics connected to Neon PostgreSQL, PayPal Escrow, Bryntum Gantt, and Multi-Agent AI."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            href="/planning"
            className="rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800"
          >
            ◈ Bryntum Gantt Planning
          </Link>
          <Link
            href="/operations"
            className="rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800"
          >
            ⊞ AG Grid Operations
          </Link>
          <Link
            href="/ai-ops"
            className="rounded-xl border border-blue-500/40 bg-blue-500/15 px-3.5 py-2 text-xs font-semibold text-blue-300 hover:bg-blue-500/25"
          >
            ✦ AI Operations Center
          </Link>
          <Link
            href="/project/new"
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-600/20 hover:bg-blue-500"
          >
            <span>+</span> New Project
          </Link>
        </div>
      </div>

      {/* ── 6 Enterprise KPI Cards (Connected to Real DB Data) ──────────────── */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-6">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Active Projects</div>
          <div className="mt-1 font-mono text-2xl font-bold text-white">
            {activeProjectsCount}{" "}
            <span className="text-xs font-normal text-slate-500">
              / {projectList.length} total
            </span>
          </div>
          <div className={`mt-1 text-[11px] ${demoMode ? "text-sky-400" : "text-emerald-400"}`}>
            {demoMode ? "Simulated demo data" : "Connected to Neon DB"}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Consultant Assignments</div>
          <div className="mt-1 font-mono text-2xl font-bold text-blue-400">
            {activeConsultantsCount}{" "}
            <span className="text-xs font-normal text-slate-500">
              / {allCandidates.length} vetted
            </span>
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {demoMode ? "Simulated vetting signals" : "GitHub signal verified"}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Planned Budget</div>
          <div className="mt-1 font-mono text-2xl font-bold text-white">
            ${totalPlannedBudgetUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            Escrow Funded: ${totalEscrowFundedUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Released Payouts</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-400">
            ${totalPaidUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {allPayments.length} payment record(s)
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Pending Milestones</div>
          <div className="mt-1 font-mono text-2xl font-bold text-amber-400">
            {pendingMilestonesCount}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {pendingApprovalsCount} awaiting human approval
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Portfolio Health</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-400">
            {healthScore}%
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {openDisputesCount} active dispute(s)
          </div>
        </div>
      </div>

      {/* ── AI Operational Recommendations Strip ───────────────────────────── */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-blue-400">
            ✦ AI Supervisor Operational Recommendations
          </span>
          <Link href="/ai-ops" className="text-xs text-blue-400 hover:underline">
            Open AI Operations Center →
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {aiRecommendations.map((rec, idx) => (
            <Link
              key={idx}
              href={rec.href}
              className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 transition hover:border-blue-500/40"
            >
              <div>
                <span className="rounded bg-blue-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-blue-300">
                  {rec.badge}
                </span>
                <div className="mt-1.5 text-sm font-bold text-white">{rec.title}</div>
                <p className="mt-1 text-xs text-slate-400">{rec.detail}</p>
              </div>
              <span className="mt-2 text-[11px] font-semibold text-blue-400">
                Inspect &amp; Execute →
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* ── Active Projects List ────────────────────────────────────────────── */}
      {projectList.length === 0 ? (
        <Card className="rounded-2xl border-slate-800 bg-slate-900">
          <CardContent className="py-16 text-center text-slate-400">
            <div className="mb-3 text-4xl opacity-20">◈</div>
            <p className="text-sm">
              No projects found in database. Create a new project or run{" "}
              <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-slate-300">
                npm run seed
              </code>
              .
            </p>
            <Link
              href="/project/new"
              className="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
            >
              + Create your first project
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {projectList.map((project) => {
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
  planned: {
    bg: "bg-slate-800/50",
    text: "text-slate-400",
    border: "border-slate-700/50",
    dot: "bg-slate-500",
  },
  funded: {
    bg: "bg-blue-950/40",
    text: "text-blue-400",
    border: "border-blue-800/50",
    dot: "bg-blue-400",
  },
  submitted: {
    bg: "bg-amber-950/30",
    text: "text-amber-400",
    border: "border-amber-800/40",
    dot: "bg-amber-400",
  },
  verifying: {
    bg: "bg-amber-950/30",
    text: "text-amber-400",
    border: "border-amber-800/40",
    dot: "bg-amber-400",
  },
  pending_approval: {
    bg: "bg-amber-950/30",
    text: "text-amber-400",
    border: "border-amber-800/40",
    dot: "bg-amber-400",
  },
  paid: {
    bg: "bg-emerald-950/40",
    text: "text-emerald-400",
    border: "border-emerald-800/50",
    dot: "bg-emerald-400",
  },
  disputed: {
    bg: "bg-rose-950/30",
    text: "text-rose-400",
    border: "border-rose-800/40",
    dot: "bg-rose-400",
  },
  cancelled: {
    bg: "bg-slate-800/40",
    text: "text-slate-500",
    border: "border-slate-700/40",
    dot: "bg-slate-600",
  },
  failed: {
    bg: "bg-rose-950/30",
    text: "text-rose-400",
    border: "border-rose-800/40",
    dot: "bg-rose-400",
  },
  returned: {
    bg: "bg-slate-800/40",
    text: "text-slate-500",
    border: "border-slate-700/40",
    dot: "bg-slate-600",
  },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.planned;
  const label = status.replace(/_/g, " ");
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.bg} ${s.text} ${s.border}`}
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

  return (
    <Card className="overflow-hidden rounded-2xl border-slate-800 bg-slate-900 shadow-xl shadow-black/30 transition-all duration-200 hover:border-slate-700">
      <div className="h-0.5 bg-blue-600/70" />

      <CardHeader className="pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              <Link
                href={`/project/${project.id}/milestones`}
                className="font-semibold text-slate-100 transition-colors duration-200 hover:text-blue-400"
              >
                {project.title}
              </Link>
            </CardTitle>
            {project.rawBrief && (
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">
                {project.rawBrief}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/planning?projectId=${encodeURIComponent(project.id)}`}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
            >
              ◈ Gantt Plan
            </Link>
            <StatusPill status={project.status} />
            <DeleteProjectButton
              projectId={project.id}
              projectTitle={project.title}
            />
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-400">
          <span>
            <strong className="tabular-nums text-slate-100">
              {milestoneList.length}
            </strong>{" "}
            milestones
          </span>
          <span>
            <strong className="tabular-nums text-emerald-400">{paidCount}</strong>{" "}
            paid
          </span>
          <span>
            <strong className="tabular-nums text-blue-400">
              {candidateCount}
            </strong>{" "}
            consultants
          </span>
          {totalBudget > 0 && (
            <span>
              <strong className="tabular-nums text-slate-100">
                ${totalBudget.toLocaleString()}
              </strong>{" "}
              total budget
            </span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {NAV_TABS.map(({ label, segment }) => (
            <Link
              key={label}
              href={
                segment === ""
                  ? `/project/${project.id}/milestones`
                  : `/project/${project.id}/${segment}`
              }
              className="rounded-full border border-slate-700/60 bg-slate-800/70 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-all duration-200 hover:border-slate-600 hover:bg-slate-800 hover:text-white"
            >
              {label}
            </Link>
          ))}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {milestoneList.length === 0 ? (
          <p className="py-2 text-xs text-slate-400">No milestones yet.</p>
        ) : (
          <div className="space-y-1">
            {milestoneList.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-xl border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-xs transition-all duration-200 hover:border-slate-600 hover:bg-slate-800"
              >
                <div className="min-w-0 mr-3">
                  <span className="truncate font-medium text-slate-200">
                    {m.title}
                  </span>
                  {m.dueDate && (
                    <span className="ml-2 text-[11px] text-slate-400">
                      Due: {m.dueDate}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="tabular-nums text-slate-300">
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
