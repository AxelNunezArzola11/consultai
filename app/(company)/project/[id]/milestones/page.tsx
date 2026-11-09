// Disable static pre-rendering: reads DB at request time.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { projects, milestones, auditLog } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { MoneyFlowPanel } from "@/components/payments/MoneyFlowPanel";
import { MilestonesClientExtensions } from "./MilestonesClientExtensions";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { requireProjectAccess } from "@/lib/auth/guards";

/**
 * Milestones page — Enterprise WBS & Escrow Execution Schedule
 */

const STATUS_STYLES: Record<string, { bg: string; text: string; border: string; dot: string; label: string }> = {
  planned:          { bg: "bg-slate-800/70",    text: "text-slate-300",   border: "border-slate-700",      dot: "bg-slate-400",   label: "Planned" },
  funded:           { bg: "bg-blue-950/50",     text: "text-blue-300",    border: "border-blue-700/60",    dot: "bg-blue-400",    label: "Held in Escrow" },
  submitted:        { bg: "bg-amber-950/40",    text: "text-amber-300",   border: "border-amber-700/60",   dot: "bg-amber-400",   label: "Submitted" },
  verifying:        { bg: "bg-amber-950/40",    text: "text-amber-300",   border: "border-amber-700/60",   dot: "bg-amber-400",   label: "Verifying PR" },
  pending_approval: { bg: "bg-amber-950/40",    text: "text-amber-300",   border: "border-amber-700/60",   dot: "bg-amber-400",   label: "Awaiting Approval" },
  paid:             { bg: "bg-emerald-950/50",  text: "text-emerald-300", border: "border-emerald-700/60", dot: "bg-emerald-400", label: "Paid" },
  disputed:         { bg: "bg-rose-950/40",     text: "text-rose-300",    border: "border-rose-700/60",    dot: "bg-rose-400",    label: "Disputed" },
  cancelled:        { bg: "bg-slate-800/50",    text: "text-slate-400",   border: "border-slate-700/50",   dot: "bg-slate-500",   label: "Cancelled" },
  failed:           { bg: "bg-rose-950/40",     text: "text-rose-300",    border: "border-rose-700/60",    dot: "bg-rose-400",    label: "Failed" },
  returned:         { bg: "bg-slate-800/50",    text: "text-slate-400",   border: "border-slate-700/50",   dot: "bg-slate-500",   label: "Returned" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.planned;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${s.bg} ${s.text} ${s.border}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
      {s.label ?? status}
    </span>
  );
}

export default async function MilestonesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Role gate + company ownership (live); cross-company -> notFound, before any query.
  await requireProjectAccess(id);

  if (isDemoMode()) {
    const t = getDemoTables();
    const project = t.projects.find((p) => p.id === id);
    if (!project) notFound();
    const milestoneList = t.milestones
      .filter((m) => m.projectId === id)
      .sort((a, b) => a.position - b.position);
    const auditEntries = t.auditLog
      .filter((a) => a.entityType === "milestone")
      .sort((a, b) => +b.createdAt - +a.createdAt)
      .slice(0, 100);
    return (
      <MilestonesView projectId={id} project={project} milestoneList={milestoneList} auditEntries={auditEntries} demoMode />
    );
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (!project) notFound();

  const milestoneList = await db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, id))
    .orderBy(milestones.position);

  const auditEntries = milestoneList.length > 0
    ? await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityType, "milestone"))
        .orderBy(desc(auditLog.createdAt))
        .limit(100)
    : [];

  return (
    <MilestonesView projectId={id} project={project} milestoneList={milestoneList} auditEntries={auditEntries} />
  );
}

function MilestonesView({
  projectId,
  project,
  milestoneList,
  auditEntries,
  demoMode,
}: {
  projectId: string;
  project: typeof projects.$inferSelect;
  milestoneList: Array<typeof milestones.$inferSelect>;
  auditEntries: Array<typeof auditLog.$inferSelect>;
  demoMode?: boolean;
}) {
  const totalBudget = milestoneList.reduce((acc, m) => acc + Number(m.budgetUsd), 0);
  const paidBudget = milestoneList
    .filter((m) => m.status === "paid")
    .reduce((acc, m) => acc + Number(m.budgetUsd), 0);
  const escrowBudget = milestoneList
    .filter((m) => ["funded", "verifying", "pending_approval"].includes(m.status))
    .reduce((acc, m) => acc + Number(m.budgetUsd), 0);
  const paidCount = milestoneList.filter((m) => m.status === "paid").length;

  return (
    <div className="px-4 sm:px-6 py-7 max-w-6xl mx-auto w-full space-y-6">
      {/* Executive Project Header & Escrow Telemetry */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-white tracking-tight">{project.title}</h1>
          <p className="text-slate-300 text-xs mt-1 max-w-3xl leading-relaxed">
            {project.rawBrief || "Milestones, WBS schedule dates, PayPal escrow captures, and delivery verification status."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Link
            href={`/planning?projectId=${encodeURIComponent(projectId)}`}
            className="rounded-lg border border-slate-700/80 bg-[#0f141e] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
          >
            ◈ Open in Bryntum Gantt
          </Link>
          <Link
            href={`/project/${projectId}/approvals`}
            className="rounded-lg border border-blue-500/35 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-500/20"
          >
            ◆ Payout Approvals
          </Link>
        </div>
      </div>

      {/* 4-Metric Financial Summary Bar */}
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-800 bg-slate-800 gap-px sm:grid-cols-4">
        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Total Contract Budget</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-white">
            ${totalBudget.toLocaleString()}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Across {milestoneList.length} WBS milestones
          </div>
        </div>

        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Active in Escrow</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-blue-400">
            ${escrowBudget.toLocaleString()}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Captured &amp; protected
          </div>
        </div>

        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Released Payouts</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-emerald-400">
            ${paidBudget.toLocaleString()}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Verified &amp; disbursed
          </div>
        </div>

        <div className="bg-[#0f141e] p-4">
          <div className="text-xs font-medium text-slate-300">Milestone Completion</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-white">
            {paidCount} / {milestoneList.length}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Paid &amp; closed
          </div>
        </div>
      </div>

      {/* Client-side extensions: compliance bar, meetings, payment chat, gantt */}
      <MilestonesClientExtensions
        projectId={projectId}
        milestones={milestoneList.map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          budgetUsd: m.budgetUsd,
        }))}
        ganttMilestones={milestoneList.map((m) => ({
          id:          m.id,
          title:       m.title,
          startDate:   m.startDate   ?? null,
          dueDate:     m.dueDate     ?? null,
          status:      m.status,
          dependsOnId: m.dependsOnId ?? null,
          offsetDays:  m.offsetDays  ?? null,
          version:     m.version,
        }))}
      />

      {/* WBS Milestone Execution Cards (promoted to immediate visibility) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">
            Work Breakdown Structure &amp; Milestone Escrow ({milestoneList.length})
          </h2>
          <span className="text-xs text-slate-400">
            Ordered by critical-path execution sequence
          </span>
        </div>

        {milestoneList.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-[#0f141e] p-10 text-center">
            <div className="text-3xl mb-2 text-slate-500">◈</div>
            <p className="text-slate-300 text-sm font-medium">No milestones for this project.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {milestoneList.map((m, idx) => {
              const relatedAudit = auditEntries
                .filter((a) => a.entityId === m.id)
                .map((a) => ({
                  id:        String(a.id),
                  event:     a.event,
                  actor:     a.actor,
                  createdAt: a.createdAt.toISOString(),
                  payload:   (a.payload as Record<string, unknown> | null) ?? null,
                }));

              return (
                <div
                  key={m.id}
                  className="rounded-xl border border-slate-800 bg-[#0f141e] overflow-hidden shadow-sm transition-colors hover:border-slate-700"
                >
                  {/* Card header */}
                  <div className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 bg-[#0c111a]">
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-slate-700/80 bg-slate-900 font-mono text-xs font-bold tabular-nums text-slate-200">
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-white">{m.title}</h3>
                        {m.description && (
                          <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">{m.description}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right">
                        <p className="text-[10px] text-slate-400 font-medium">Budget</p>
                        <p className="text-sm font-mono font-bold text-white tabular-nums">
                          ${Number(m.budgetUsd).toLocaleString()}
                        </p>
                      </div>
                      {m.dueDate && (
                        <div className="text-right">
                          <p className="text-[10px] text-slate-400 font-medium">Target Due</p>
                          <p className="text-xs font-mono text-slate-200 tabular-nums">{m.dueDate}</p>
                        </div>
                      )}
                      <StatusPill status={m.status} />
                    </div>
                  </div>

                  {/* Money-flow panel */}
                  <div className="px-5 py-4">
                    <MoneyFlowPanel
                      milestoneId={m.id}
                      milestoneTitle={m.title}
                      budgetUsd={m.budgetUsd}
                      initialStatus={m.status}
                      initialGrossUsd={m.captureGrossUsd ?? null}
                      initialFeeUsd={m.captureFeeUsd ?? null}
                      initialNetUsd={m.captureNetUsd ?? null}
                      initialCurrency={m.currency ?? null}
                      initialAudit={relatedAudit}
                      fundingDisabledReason={
                        demoMode
                          ? "PayPal funding is unavailable in offline demo mode. The ledger above shows simulated captures for this fictional scenario."
                          : undefined
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
