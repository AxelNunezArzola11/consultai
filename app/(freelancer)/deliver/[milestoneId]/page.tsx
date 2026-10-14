// Disable static pre-rendering
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { milestones, projects } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { PRSubmitForm } from "@/components/delivery/PRSubmitForm";
import { Badge } from "@/components/ui/badge";

export default async function FreelancerDeliverPage({
  params,
}: {
  params: Promise<{ milestoneId: string }>;
}) {
  const { milestoneId } = await params;

  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, milestoneId))
    .limit(1);

  if (!milestone) notFound();

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, milestone.projectId))
    .limit(1);

  // Milestone must be funded or submitted to accept a PR
  const canSubmit = ["funded", "submitted", "verifying"].includes(milestone.status);

  return (
    <div className="px-6 py-8 max-w-2xl mx-auto w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Submit Deliverable</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {project?.title ?? "Project"} — {milestone.title}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{milestone.status}</Badge>
          <span className="inline-flex items-center rounded-full border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            Sandbox mode
          </span>
        </div>
      </div>

      {!canSubmit ? (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          This milestone is in status <strong>{milestone.status}</strong> and is not currently
          accepting deliverables. The milestone must be <strong>funded</strong> before you can
          submit a PR.
        </div>
      ) : (
        <PRSubmitForm milestoneId={milestoneId} milestoneTitle={milestone.title} />
      )}
    </div>
  );
}
