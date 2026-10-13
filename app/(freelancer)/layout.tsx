import Link from "next/link";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import type { ReactNode } from "react";

/**
 * Freelancer layout — wraps all freelancer-facing pages.
 */
export default function FreelancerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col flex-1">
      <header className="border-b bg-background px-6 py-3 flex items-center justify-between">
        <nav className="flex items-center gap-6 text-sm font-medium">
          <Link href="/" className="text-xl font-bold tracking-tight">
            ConsultAI
          </Link>
          <Link
            href="/demo-inbox"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Demo Inbox
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
            Freelancer view
          </span>
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
            Switch role
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
