"use client";

/**
 * ProjectNav — per-project sub-navigation tabs.
 *
 * Renders a horizontal tab bar below the top header for all /project/[id]/* pages.
 * Uses usePathname() to highlight the active tab — requires "use client".
 *
 * Tabs (in display order):
 *   Milestones  → /project/[id]/milestones
 *   Candidates  → /project/[id]/candidates
 *   Vetting     → /project/[id]/vetting      ← GitHub portfolio + quadrant chart
 *   Ledger      → /project/[id]/ledger
 *   Approvals   → /project/[id]/approvals
 *   Delivery    → /project/[id]/delivery
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  label: string;
  href: string;
  /** Subtitle shown on hover */
  description: string;
}

function tabs(id: string): Tab[] {
  return [
    { label: "Milestones",  href: `/project/${id}/milestones`,  description: "Payments & status" },
    { label: "Candidates",  href: `/project/${id}/candidates`,  description: "Candidate pipeline" },
    { label: "Vetting",     href: `/project/${id}/vetting`,     description: "GitHub portfolio & quadrant chart" },
    { label: "Ledger",      href: `/project/${id}/ledger`,      description: "Financial ledger (AG Grid)" },
    { label: "Approvals",   href: `/project/${id}/approvals`,   description: "Payout approvals" },
    { label: "Delivery",    href: `/project/${id}/delivery`,    description: "Delivery verification" },
  ];
}

interface Props {
  projectId: string;
}

export function ProjectNav({ projectId }: Props) {
  const pathname = usePathname();

  return (
    <nav
      className="border-b bg-background px-6 flex items-center gap-1 overflow-x-auto"
      aria-label="Project sections"
    >
      {tabs(projectId).map((tab) => {
        const isActive = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            title={tab.description}
            className={[
              "px-3 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-foreground/30",
            ].join(" ")}
            aria-current={isActive ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
