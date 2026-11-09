import Link from "next/link";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import { ActiveNavLink } from "@/components/shared/ActiveNavLink";
import { AccountStatusNav } from "@/components/shared/AccountStatusNav";
import { requirePageRole } from "@/lib/auth/guards";
import type { ReactNode } from "react";

/**
 * Administrator Layout — wraps platform governance, dispute resolution,
 * AI execution monitoring, and security audit pages (`/admin`).
 * Admin-only: authenticates + authorizes before any child page queries or renders.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requirePageRole(["admin"]);
  return (
    <div className="flex flex-1 flex-col bg-[#090c12] text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-[#0b0f17]/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3 overflow-x-auto no-scrollbar">
            <Link
              href="/"
              className="flex items-center gap-2.5 text-sm font-bold tracking-tight text-white hover:text-cyan-400 shrink-0"
            >
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-cyan-600 font-mono text-xs font-bold text-white shadow-sm shadow-cyan-600/30">
                CA
              </span>
              <span>ConsultAI Admin</span>
            </Link>

            <div className="h-4 w-px bg-slate-800 shrink-0" />

            <nav className="flex items-center gap-1" aria-label="Admin navigation">
              <ActiveNavLink href="/admin">
                Platform Governance
              </ActiveNavLink>
              <ActiveNavLink href="/ai-ops">
                <span className="text-blue-400">✦</span> AI Operations Center
              </ActiveNavLink>
              <ActiveNavLink href="/operations">
                <span className="text-cyan-400">⊞</span> Enterprise Grids
              </ActiveNavLink>
            </nav>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <AccountStatusNav portalRole="admin" />
            <div className="hidden md:flex items-center gap-1 border-l border-slate-800 pl-2">
              <Link
                href="/dashboard"
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-400 whitespace-nowrap hover:bg-slate-900 hover:text-white"
              >
                Company View
              </Link>
              <Link
                href="/"
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-400 whitespace-nowrap hover:bg-slate-900 hover:text-white"
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
