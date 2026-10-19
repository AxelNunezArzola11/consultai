// Disable static pre-rendering: this page reads from the DB at request time.
// Without this, next build would attempt to statically generate it and fail
// when DATABASE_URL is not available in the build environment.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { projects, milestones } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteProjectButton } from "@/components/shared/DeleteProjectButton";

/**
 * Company dashboard — server component.
 * Shows the seeded project and its milestones.
 * Phase 0: read-only display of DB data. Interactive features added in Phases 1+.
 */
export default async function DashboardPage() {
  const projectList = await db
    .select()
    .from(projects)
    .limit(10);

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto w-full space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Your active projects and milestones
        </p>
      </div>

      {projectList.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No projects yet. Run{" "}
            <code className="bg-muted px-1 rounded text-xs">npm run seed</code>{" "}
            to load demo data.
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

  const statusColour: Record<string, string> = {
    planned: "secondary",
    funded: "default",
    submitted: "outline",
    verifying: "outline",
    pending_approval: "outline",
    paid: "default",
    disputed: "destructive",
    cancelled: "secondary",
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">
            <Link
              href={`/project/${project.id}/milestones`}
              className="hover:underline"
            >
              {project.title}
            </Link>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{project.status}</Badge>
            <DeleteProjectButton
              projectId={project.id}
              projectTitle={project.title}
            />
          </div>
        </div>
        {/* Quick-nav links to the most-used project sub-pages */}
        <div className="flex flex-wrap gap-2 mt-2">
          {[
            { label: "Milestones",  href: `/project/${project.id}/milestones` },
            { label: "Candidates",  href: `/project/${project.id}/candidates` },
            { label: "Vetting",     href: `/project/${project.id}/vetting` },
            { label: "Ledger",      href: `/project/${project.id}/ledger` },
            { label: "Approvals",   href: `/project/${project.id}/approvals` },
          ].map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              className="text-xs text-muted-foreground hover:text-foreground border rounded px-2 py-0.5 transition-colors"
            >
              {label}
            </Link>
          ))}
        </div>
        {project.rawBrief && (
          <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
            {project.rawBrief}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <h3 className="text-sm font-medium mb-2">Milestones</h3>
        {milestoneList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No milestones yet.</p>
        ) : (
          <ul className="space-y-2">
            {milestoneList.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between text-sm border rounded-lg px-3 py-2"
              >
                <span className="font-medium">{m.title}</span>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">
                    ${Number(m.budgetUsd).toLocaleString()}
                  </span>
                  <Badge
                    variant={
                      (statusColour[m.status] as
                        | "default"
                        | "secondary"
                        | "outline"
                        | "destructive") ?? "outline"
                    }
                  >
                    {m.status}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
