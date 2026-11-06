import Link from "next/link";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import { ActiveNavLink } from "@/components/shared/ActiveNavLink";
import type { ReactNode } from "react";

/**
 * Company layout — wraps all company-facing enterprise pages:
 * Dashboard, Planning (Bryntum Gantt), Operations (AG Grid), AI Ops Center, and Project creation.
 */
export default function CompanyLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950/95 px-6 backdrop-blur-sm">
        <nav className="flex h-full items-center gap-6 text-sm font-medium">
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-bold tracking-tight text-white transition-colors hover:text-blue-400"
          >
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-600 text-xs font-bold text-white">
              CA
            </span>
            ConsultAI
          </Link>

          <div className="h-5 w-px bg-slate-800" />

          <ActiveNavLink
            href="/dashboard"
            className="text-slate-300 transition-colors hover:text-white"
          >
            Dashboard
          </ActiveNavLink>
          <ActiveNavLink
            href="/planning"
            className="text-slate-300 transition-colors hover:text-white"
          >
            ◈ Planning (Gantt)
          </ActiveNavLink>
          <ActiveNavLink
            href="/operations"
            className="text-slate-300 transition-colors hover:text-white"
          >
            ⊞ Operations (AG Grid)
          </ActiveNavLink>
          <ActiveNavLink
            href="/ai-ops"
            className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-300 transition-colors hover:bg-blue-500/20"
          >
            ✦ AI Ops Center
          </ActiveNavLink>
          <ActiveNavLink
            href="/project/new"
            className="text-slate-400 transition-colors hover:text-white"
          >
            + New Project
          </ActiveNavLink>
        </nav>

        <div className="flex items-center gap-3">
          <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-300">
            Company Operator
          </span>
          <Link
            href="/freelancer"
            className="rounded-md px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-slate-900 hover:text-white"
          >
            Freelancer View
          </Link>
          <Link
            href="/admin"
            className="rounded-md px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-slate-900 hover:text-white"
          >
            Admin View
          </Link>
          <Link
            href="/"
            className="rounded-md px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-slate-900 hover:text-white"
          >
            Switch Role
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
