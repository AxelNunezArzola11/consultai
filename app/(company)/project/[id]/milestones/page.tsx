// Disable static pre-rendering: reads DB at request time.
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects, milestones, auditLog } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { MoneyFlowPanel } from "@/components/payments/MoneyFlowPanel";
import { MilestonesClientExtensions } from "./MilestonesClientExtensions";

/**
 * Milestones page — Phase 1 Step 6.
 * Visual: AG Studio Midnight slate cards, status pills, polished typography.
 */

const STATUS_STYLES: Record<string, { bg: string; text: string; border: string; dot: string; label: string }> = {
  planned:          { bg: "bg-slate-800/50",    text: "text-slate-400",   border: "border-slate-700/50",   dot: "bg-slate-500",   label: "Planned" },
  funded:           { bg: "bg-primary/10",      text: "text-primary",     border: "border-primary/20",     dot: "bg-primary",     label: "Held (simulated)" },
  submitted:        { bg: "bg-amber-950/30",    text: "text-amber-400",   border: "border-amber-800/40",   dot: "bg-amber-400",   label: "Submitted" },
  verifying:        { bg: "bg-amber-950/30",    text: "text-amber-400",   border: "border-amber-800/40",   dot: "bg-amber-400",   label: "Verifying" },
  pending_approval: { bg: "bg-amber-950/30",    text: "text-amber-400",   border: "border-amber-800/40",   dot: "bg-amber-400",   label: "Awaiting Approval" },
  paid:             { bg: "bg-emerald-950/40",  text: "text-emerald-400", border: "border-emerald-800/50", dot: "bg-emerald-400", label: "Paid" },
  disputed:         { bg: "bg-rose-950/30",     text: "text-rose-400",    border: "border-rose-800/40",    dot: "bg-rose-400",    label: "Disputed" },
  cancelled:        { bg: "bg-slate-800/40",    text: "text-slate-500",   border: "border-slate-700/40",   dot: "bg-slate-600",   label: "Cancelled" },
  failed:           { bg: "bg-rose-950/30",     text: "text-rose-400",    border: "border-rose-800/40",    dot: "bg-rose-400",    label: "Failed" },
  returned:         { bg: "bg-slate-800/40",    text: "text-slate-500",   border: "border-slate-700/40",   dot: "bg-slate-600",   label: "Returned" },
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

  const totalBudget = milestoneList.reduce((acc, m) => acc + Number(m.budgetUsd), 0);
  const paidCount = milestoneList.filter((m) => m.status === "paid").length;

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto w-full space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">{project.title}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Milestones &amp; Payments</p>
        </div>
        {/* Budget stats */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide font-medium">Total</p>
            <p className="text-foreground font-semibold tabular-nums text-sm">${totalBudget.toLocaleString()}</p>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide font-medium">Paid</p>
            <p className="text-emerald-400 font-semibold tabular-nums text-sm">{paidCount}/{milestoneList.length}</p>
          </div>
        </div>
      </div>

      {/* Client-side extensions: compliance bar, meetings, payment chat, gantt */}
      <MilestonesClientExtensions
        projectId={id}
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

      {milestoneList.length === 0 ? (
        <div className="rounded-xl border border-border bg-card/50 p-8 text-center">
          <div className="text-4xl mb-3 opacity-20">◈</div>
          <p className="text-muted-foreground text-sm">No milestones for this project.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {milestoneList.map((m) => {
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
                className="rounded-xl border border-border bg-card overflow-hidden shadow-sm hover:shadow-md transition-all"
              >
                {/* Card header */}
                <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-3 border-b border-border/50">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground">{m.title}</h3>
                    {m.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{m.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Budget</p>
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        ${Number(m.budgetUsd).toLocaleString()}
                      </p>
                    </div>
                    {m.dueDate && (
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Due</p>
                        <p className="text-xs text-foreground font-medium">{m.dueDate}</p>
                      </div>
                    )}
                    <StatusPill status={m.status} />
                  </div>
                </div>

                {/* Money-flow panel */}
                <div className="px-4 pb-4 pt-3">
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
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
