// Disable static pre-rendering
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { milestones, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { PRSubmitForm } from "@/components/delivery/PRSubmitForm";
import { Badge } from "@/components/ui/badge";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { requirePageRole, candidateIdsForFreelancer } from "@/lib/auth/guards";

export default async function FreelancerDeliverPage({
  params,
}: {
  params: Promise<{ milestoneId: string }>;
}) {
  const { milestoneId } = await params;
  // Authenticate + authorize BEFORE querying/rendering (demo bypass: fixtures only).
  const auth = await requirePageRole(["company", "freelancer", "admin"]);
  if (!auth.demoBypass && !auth.session) {
    // Live session-less holder: no verified identity to authorize the
    // delivery workspace — re-authenticate instead of rendering it.
    redirect("/login");
  }
  const demoTables = isDemoMode() ? getDemoTables() : null;

  const milestone = demoTables
    ? demoTables.milestones.find((m) => m.id === milestoneId)
    : (
        await db
          .select()
          .from(milestones)
          .where(eq(milestones.id, milestoneId))
          .limit(1)
      )[0];

  if (!milestone) notFound();

  const project = demoTables
    ? demoTables.projects.find((p) => p.id === milestone.projectId)
    : (
        await db
          .select()
          .from(projects)
          .where(eq(projects.id, milestone.projectId))
          .limit(1)
      )[0];

  // Live authorization before rendering: company sessions see their own
  // company's milestones; freelancer sessions only milestones in projects
  // where they hold a candidacy (by session email/githubHandle).
  if (!auth.demoBypass) {
    if (auth.session?.role === "company" && auth.session.companyId) {
      if (!project || project.companyId !== auth.session.companyId) notFound();
    } else if (auth.session?.role === "freelancer") {
      const assigned = await candidateIdsForFreelancer(auth, milestone.projectId);
      if (assigned !== null && assigned.length === 0) notFound();
    }
  }

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
