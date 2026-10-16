import Link from "next/link";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import type { ReactNode } from "react";

/**
 * Company layout — wraps all company-facing pages.
 * SandboxBadge is rendered in the root layout (app/layout.tsx).
 */
export default function CompanyLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col flex-1">
      {/* Top navigation */}
      <header className="border-b bg-background px-6 py-3 flex items-center justify-between">
        <nav className="flex items-center gap-6 text-sm font-medium">
          <Link href="/" className="text-xl font-bold tracking-tight">
            ConsultAI
          </Link>
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
          <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
            Company view
          </span>
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
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
