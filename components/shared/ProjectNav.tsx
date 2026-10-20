"use client";

/**
 * ProjectNav — per-project sub-navigation tabs.
 *
 * Visual: AG Studio Midnight tab bar — dark card bg, blue active underline,
 * smooth transitions, compact typography.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  label: string;
  href: string;
  description: string;
  icon: string;
}

function tabs(id: string): Tab[] {
  return [
    { label: "Milestones",  href: `/project/${id}/milestones`,  description: "Payments & status",                icon: "◈" },
    { label: "Candidates",  href: `/project/${id}/candidates`,  description: "Candidate pipeline",               icon: "◉" },
    { label: "Vetting",     href: `/project/${id}/vetting`,     description: "GitHub portfolio & quadrant chart", icon: "◎" },
    { label: "Ledger",      href: `/project/${id}/ledger`,      description: "Financial ledger (AG Grid)",        icon: "◧" },
    { label: "Approvals",   href: `/project/${id}/approvals`,   description: "Payout approvals",                  icon: "◆" },
    { label: "Delivery",    href: `/project/${id}/delivery`,    description: "Delivery verification",             icon: "◇" },
  ];
}

interface Props {
  projectId: string;
}

export function ProjectNav({ projectId }: Props) {
  const pathname = usePathname();

  return (
    <nav
      className="border-b border-border bg-card/95 backdrop-blur-sm px-6 flex items-center gap-0.5 overflow-x-auto shrink-0"
      aria-label="Project sections"
      style={{ minHeight: "44px" }}
    >
      {tabs(projectId).map((tab) => {
        const isActive = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            title={tab.description}
            className={[
              "relative px-3 py-2.5 text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1.5",
              "after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:rounded-t-sm after:transition-all",
              isActive
                ? "text-primary after:bg-primary"
                : "text-muted-foreground hover:text-foreground after:bg-transparent hover:after:bg-border",
            ].join(" ")}
            aria-current={isActive ? "page" : undefined}
          >
            <span className={`text-[10px] ${isActive ? "text-primary" : "text-muted-foreground/60"}`}>
              {tab.icon}
            </span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
