"use client";

/**
 * ProjectNav — per-project sub-navigation tabs + breadcrumb context.
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
    { label: "Milestones",  href: `/project/${id}/milestones`,  description: "Payments & WBS status",             icon: "◈" },
    { label: "Timeline",    href: `/project/${id}/timeline`,    description: "Gantt / milestone timeline",        icon: "▤" },
    { label: "Candidates",  href: `/project/${id}/candidates`,  description: "Candidate NDA & booking pipeline",  icon: "◉" },
    { label: "Vetting",     href: `/project/${id}/vetting`,     description: "GitHub portfolio & quadrant chart", icon: "◎" },
    { label: "Ledger",      href: `/project/${id}/ledger`,      description: "Financial ledger (AG Grid)",        icon: "◧" },
    { label: "Approvals",   href: `/project/${id}/approvals`,   description: "Human-gated payout approvals",      icon: "◆" },
    { label: "Delivery",    href: `/project/${id}/delivery`,    description: "PR delivery verification",          icon: "◇" },
  ];
}

interface Props {
  projectId: string;
  projectTitle?: string;
  projectStatus?: string;
}

export function ProjectNav({ projectId, projectTitle, projectStatus }: Props) {
  const pathname = usePathname();

  return (
    <div className="border-b border-slate-800/80 bg-[#0d121d]/90 backdrop-blur-sm shrink-0">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-2">
        {/* Breadcrumb context */}
        <div className="flex items-center gap-2 text-xs min-w-0">
          <Link
            href="/dashboard"
            className="text-slate-400 hover:text-slate-200 transition-colors shrink-0"
          >
            Projects
          </Link>
          <span className="text-slate-600">/</span>
          <span className="font-semibold text-slate-200 truncate max-w-[260px] sm:max-w-[380px]">
            {projectTitle ?? projectId}
          </span>
          {projectStatus && (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 shrink-0">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {projectStatus}
            </span>
          )}
        </div>

        {/* Sub-navigation tabs */}
        <nav
          className="flex items-center gap-1 overflow-x-auto no-scrollbar"
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
                  "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-blue-600/15 text-blue-300 border border-blue-500/30"
                    : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200 border border-transparent",
                ].join(" ")}
                aria-current={isActive ? "page" : undefined}
              >
                <span className={`text-[10px] ${isActive ? "text-blue-400" : "text-slate-500"}`}>
                  {tab.icon}
                </span>
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
