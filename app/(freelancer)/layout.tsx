import Link from "next/link";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import { ActiveNavLink } from "@/components/shared/ActiveNavLink";
import type { ReactNode } from "react";

/**
 * Freelancer layout — wraps all freelancer-facing pages (`/freelancer`, `/demo-inbox`, `/deliver/[milestoneId]`).
 */
export default function FreelancerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950/95 px-6 backdrop-blur-sm">
        <nav className="flex items-center gap-6 text-sm font-medium">
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-bold tracking-tight text-white hover:text-emerald-400"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-600 text-xs font-bold text-white">
              CA
            </span>
            ConsultAI
          </Link>

          <div className="h-5 w-px bg-slate-800" />

          <ActiveNavLink
            href="/freelancer"
            className="text-slate-300 transition-colors hover:text-white"
          >
            Consultant Dashboard
          </ActiveNavLink>
          <ActiveNavLink
            href="/demo-inbox"
            className="text-slate-300 transition-colors hover:text-white"
          >
            NDA Invitations Inbox
          </ActiveNavLink>
        </nav>

        <div className="flex items-center gap-3">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
            Freelancer Consultant
          </span>
          <Link
            href="/dashboard"
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-900 hover:text-white"
          >
            Company View
          </Link>
          <Link
            href="/"
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-900 hover:text-white"
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
