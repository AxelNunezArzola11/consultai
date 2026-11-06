// Disable static pre-rendering: reads DB at request time.
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects, milestones } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { TimelineClient } from "./TimelineClient";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";

/**
 * Timeline page — /project/[id]/timeline
 *
 * Renders the full-width Bryntum Gantt (GanttPanel via GanttPanelLazy) for all
 * project milestones, plus a pure-CSS fallback timeline when Bryntum is disabled.
 *
 * Dark-first: page background matches AG Studio Midnight (#181d1f).
 * Timeline bars (M1–M4) scale proportionally with minWidth=2rem guard so short
 * durations never clip label text horizontally.
 */

export default async function TimelinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (isDemoMode()) {
    const t = getDemoTables();
    const project = t.projects.find((p) => p.id === id);
    if (!project) notFound();
    const milestoneList = t.milestones
      .filter((m) => m.projectId === id)
      .sort((a, b) => a.position - b.position);
    return (
      <TimelineView projectId={id} projectTitle={project.title} milestoneList={milestoneList} />
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

  return (
    <TimelineView projectId={id} projectTitle={project.title} milestoneList={milestoneList} />
  );
}

function TimelineView({
  projectId,
  projectTitle,
  milestoneList,
}: {
  projectId: string;
  projectTitle: string;
  milestoneList: Array<typeof milestones.$inferSelect>;
}) {

  const ganttMilestones = milestoneList.map((m) => ({
    id:          m.id,
    title:       m.title,
    startDate:   m.startDate   ?? null,
    dueDate:     m.dueDate     ?? null,
    status:      m.status,
    dependsOnId: m.dependsOnId ?? null,
    offsetDays:  m.offsetDays  ?? null,
    version:     m.version,
  }));

  return (
    <div className="flex flex-col flex-1 px-6 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">
            {projectTitle}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Milestone Timeline
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            <strong className="text-foreground">{milestoneList.length}</strong> milestones
          </span>
        </div>
      </div>

      {milestoneList.length === 0 ? (
        <div className="rounded-xl border border-border bg-card/50 p-10 text-center">
          <div className="text-4xl mb-3 opacity-20">▤</div>
          <p className="text-muted-foreground text-sm">
            No milestones yet. Add milestones on the Milestones tab.
          </p>
        </div>
      ) : (
        <TimelineClient
          projectId={projectId}
          milestones={ganttMilestones}
        />
      )}
    </div>
  );
}
