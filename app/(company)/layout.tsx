import Link from "next/link";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import { ActiveNavLink } from "@/components/shared/ActiveNavLink";
import { AccountStatusNav } from "@/components/shared/AccountStatusNav";
import { requirePageRole } from "@/lib/auth/guards";
import type { ReactNode } from "react";

/**
 * Company layout — wraps all company-facing enterprise pages:
 * Dashboard, Planning (Bryntum Gantt), Operations (AG Grid), AI Ops Center, and Project creation.
 * Authenticates + authorizes (company|admin) before any child page queries or renders.
 */
export default async function CompanyLayout({ children }: { children: ReactNode }) {
  await requirePageRole(["company", "admin"]);
  return (
    <div className="flex flex-1 flex-col bg-[#090c12] text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-[#0b0f17]/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3 overflow-x-auto no-scrollbar">
            <Link
              href="/"
              className="flex items-center gap-2.5 text-sm font-bold tracking-tight text-white transition-colors hover:text-blue-400 shrink-0"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-600 font-mono text-xs font-bold text-white shadow-sm shadow-blue-600/30">
                CA
              </span>
              <span>ConsultAI</span>
            </Link>

            <div className="h-4 w-px bg-slate-800 shrink-0" />

            <nav className="flex items-center gap-1" aria-label="Company navigation">
              <ActiveNavLink href="/dashboard">
                Dashboard
              </ActiveNavLink>
              <ActiveNavLink href="/planning">
                <span className="text-blue-400">◈</span> Planning (Gantt)
              </ActiveNavLink>
              <ActiveNavLink href="/operations">
                <span className="text-cyan-400">⊞</span> Operations (AG Grid)
              </ActiveNavLink>
              <ActiveNavLink
                href="/ai-ops"
                className="border border-blue-500/25 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20"
              >
                <span className="text-blue-400">✦</span> AI Ops Center
              </ActiveNavLink>
              <ActiveNavLink href="/project/new">
                + New Project
              </ActiveNavLink>
            </nav>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <AccountStatusNav portalRole="company" />
            <div className="hidden lg:flex items-center gap-1 border-l border-slate-800 pl-2">
              <Link
                href="/freelancer"
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-400 whitespace-nowrap transition-colors hover:bg-slate-900 hover:text-white"
              >
                Freelancer View
              </Link>
              <Link
                href="/admin"
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-400 whitespace-nowrap transition-colors hover:bg-slate-900 hover:text-white"
              >
                Admin View
              </Link>
              <Link
                href="/"
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-400 whitespace-nowrap transition-colors hover:bg-slate-900 hover:text-white"
              >
                Switch Role
              </Link>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
