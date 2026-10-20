import Link from "next/link";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import type { ReactNode } from "react";

/**
 * Company layout — wraps all company-facing pages.
 * SandboxBadge is rendered in the root layout (app/layout.tsx).
 *
 * Visual: AG Studio Midnight header — dark slate bg, blue accent logo,
 * pill role badge, clean typography.
 */
export default function CompanyLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col flex-1">
      {/* Top navigation — Midnight tech SaaS header */}
      <header className="border-b border-border bg-card/95 backdrop-blur-sm px-6 py-0 flex items-center justify-between sticky top-0 z-40 h-14">
        <nav className="flex items-center gap-7 text-sm font-medium h-full">
          {/* Logo */}
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-bold tracking-tight text-foreground hover:text-primary transition-colors"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold shrink-0">
              CA
            </span>
            ConsultAI
          </Link>

          <div className="h-5 w-px bg-border" />

          <Link
            href="/dashboard"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Dashboard
          </Link>
          <Link
            href="/project/new"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            + New project
          </Link>
        </nav>

        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground bg-muted/60 border border-border px-2.5 py-1 rounded-full font-medium">
            Company
          </span>
          <Link
            href="/"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted/60"
          >
            Switch role
          </Link>
          <ThemeToggle />
        </div>
      </header>

      {/* Page content */}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
