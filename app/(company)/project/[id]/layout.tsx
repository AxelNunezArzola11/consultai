/**
 * Project layout — wraps all /project/[id]/* pages with a sub-navigation bar
 * and project context breadcrumb.
 */

import type { ReactNode } from "react";
import { ProjectNav } from "@/components/shared/ProjectNav";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireProjectAccess } from "@/lib/auth/guards";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Role gate + company ownership (live); cross-company -> notFound, before any query.
  await requireProjectAccess(id);

  let projectTitle: string | undefined;
  let projectStatus: string | undefined;

  try {
    if (isDemoMode()) {
      const p = getDemoTables().projects.find((row) => row.id === id);
      projectTitle = p?.title;
      projectStatus = p?.status;
    } else {
      const [p] = await db
        .select({ title: projects.title, status: projects.status })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      projectTitle = p?.title;
      projectStatus = p?.status;
    }
  } catch {
    // Graceful fallback if DB is unreachable
  }

  return (
    <div className="flex flex-col flex-1">
      <ProjectNav
        projectId={id}
        projectTitle={projectTitle}
        projectStatus={projectStatus}
      />
      <div className="flex flex-col flex-1">{children}</div>
    </div>
  );
}
