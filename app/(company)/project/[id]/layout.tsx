/**
 * Project layout — wraps all /project/[id]/* pages with a sub-navigation bar.
 *
 * Tabs: Milestones · Candidates · Vetting · Ledger · Approvals · Delivery
 *
 * This layout is added so every project sub-page inherits the nav without
 * each page needing its own header. The active tab is highlighted by
 * matching the current pathname via an activeClass on the <Link>.
 *
 * Note: Next.js App Router layouts receive children (the page) and params.
 * Layouts are Server Components — usePathname() is not available here.
 * We pass the projectId as a prop to a tiny Client Component that reads
 * usePathname() to highlight the active tab.
 */

import type { ReactNode } from "react";
import { ProjectNav } from "@/components/shared/ProjectNav";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="flex flex-col flex-1">
      <ProjectNav projectId={id} />
      <div className="flex flex-col flex-1">{children}</div>
    </div>
  );
}
