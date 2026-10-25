// Disable static pre-rendering: reads DB at request time.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { projects, milestones } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteProjectButton } from "@/components/shared/DeleteProjectButton";

/**
 * Company dashboard — server component.
 * Visual: AG Studio Midnight cards, status pills, clean typography.
 */
export default async function DashboardPage() {
  const projectList = await db
    .select()
    .from(projects)
    .limit(10);

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto w-full space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100 tracking-tight">Dashboard</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Your active projects and milestones
          </p>
        </div>
        <Link
          href="/project/new"
          className="inline-flex items-center gap-1.5 rounded-2xl bg-blue-600 text-white text-xs font-semibold px-4 py-2.5 hover:bg-blue-500 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 transition-all duration-200 shadow-lg shadow-blue-600/20"
        >
          <span className="text-sm leading-none">+</span> New project
        </Link>
      </div>

      {projectList.length === 0 ? (
        <Card className="border-slate-800 bg-slate-900 rounded-2xl">
          <CardContent className="py-16 text-center text-slate-400">
            <div className="text-4xl mb-3 opacity-20">◈</div>
            <p className="text-sm">No projects yet. Run{" "}
              <code className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded text-xs font-mono">npm run seed</code>{" "}
              to load demo data.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {projectList.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

const NAV_TABS = [
  { label: "Milestones",  segment: "milestones" },
  { label: "Candidates",  segment: "candidates" },
  { label: "Vetting",     segment: "vetting" },
  { label: "Ledger",      segment: "ledger" },
  { label: "Approvals",   segment: "approvals" },
] as const;

const STATUS_STYLES: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  planned:          { bg: "bg-slate-800/50",    text: "text-slate-400",   border: "border-slate-700/50",   dot: "bg-slate-500" },
  funded:           { bg: "bg-primary/10",      text: "text-primary",     border: "border-primary/20",     dot: "bg-primary" },
  submitted:        { bg: "bg-amber-950/30",    text: "text-amber-400",   border: "border-amber-800/40",   dot: "bg-amber-400" },
  verifying:        { bg: "bg-amber-950/30",    text: "text-amber-400",   border: "border-amber-800/40",   dot: "bg-amber-400" },
  pending_approval: { bg: "bg-amber-950/30",    text: "text-amber-400",   border: "border-amber-800/40",   dot: "bg-amber-400" },
  paid:             { bg: "bg-emerald-950/40",  text: "text-emerald-400", border: "border-emerald-800/50", dot: "bg-emerald-400" },
  disputed:         { bg: "bg-rose-950/30",     text: "text-rose-400",    border: "border-rose-800/40",    dot: "bg-rose-400" },
  cancelled:        { bg: "bg-slate-800/40",    text: "text-slate-500",   border: "border-slate-700/40",   dot: "bg-slate-600" },
  failed:           { bg: "bg-rose-950/30",     text: "text-rose-400",    border: "border-rose-800/40",    dot: "bg-rose-400" },
  returned:         { bg: "bg-slate-800/40",    text: "text-slate-500",   border: "border-slate-700/40",   dot: "bg-slate-600" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.planned;
  const label = status.replace(/_/g, " ");
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border ${s.bg} ${s.text} ${s.border}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {label}
    </span>
  );
}

async function ProjectCard({
  project,
}: {
  project: typeof projects.$inferSelect;
}) {
  const milestoneList = await db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, project.id))
    .orderBy(milestones.position);

  const totalBudget = milestoneList.reduce((acc, m) => acc + Number(m.budgetUsd), 0);
  const paidCount = milestoneList.filter((m) => m.status === "paid").length;

  return (
    <Card className="border-slate-800 bg-slate-900 rounded-2xl shadow-xl shadow-black/30 hover:shadow-2xl hover:shadow-black/40 hover:border-slate-700 transition-all duration-200 overflow-hidden">
      {/* Top accent line */}
      <div className="h-0.5 bg-blue-600/70" />

      <CardHeader className="pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              <Link
                href={`/project/${project.id}/milestones`}
                className="text-slate-100 hover:text-blue-400 transition-colors duration-200 font-semibold"
              >
                {project.title}
              </Link>
            </CardTitle>
            {project.rawBrief && (
              <p className="text-xs text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                {project.rawBrief}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusPill status={project.status} />
            <DeleteProjectButton
              projectId={project.id}
              projectTitle={project.title}
            />
          </div>
        </div>

        {/* Stats strip */}
        <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
          <span>
            <strong className="text-slate-100 tabular-nums">{milestoneList.length}</strong> milestones
          </span>
          <span>
            <strong className="text-emerald-400 tabular-nums">{paidCount}</strong> paid
          </span>
          {totalBudget > 0 && (
            <span>
              <strong className="text-slate-100 tabular-nums">${totalBudget.toLocaleString()}</strong> total
            </span>
          )}
        </div>

        {/* Quick-nav pills */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {NAV_TABS.map(({ label, segment }) => (
            <Link
              key={segment}
              href={`/project/${project.id}/${segment}`}
              className="text-[11px] font-medium text-slate-400 hover:text-slate-100 bg-slate-800/70 hover:bg-slate-800 border border-slate-700/60 hover:border-slate-600 px-2.5 py-1 rounded-full transition-all duration-200"
            >
              {label}
            </Link>
          ))}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {milestoneList.length === 0 ? (
          <p className="text-xs text-slate-400 py-2">No milestones yet.</p>
        ) : (
          <div className="space-y-1">
            {milestoneList.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between text-xs rounded-xl px-3 py-2 bg-slate-800/50 border border-slate-700/50 hover:bg-slate-800 hover:border-slate-600 transition-all duration-200"
              >
                <span className="font-medium text-slate-200 truncate mr-3">{m.title}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-slate-400 tabular-nums">
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
