"use client";

import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/shared/ThemeToggle";

/**
 * Role switcher — landing page.
 *
 * Sets a signed, httpOnly role cookie via POST /api/auth/set-role
 * (demo auth — not production auth; documented in lib/auth/role-cookie.ts).
 * Also stores the role in localStorage for client-side UI hints.
 *
 * Phase 0: two large buttons (Company / Freelancer).
 */
export default function HomePage() {
  const router = useRouter();

  async function selectRole(role: "company" | "freelancer") {
    // Set httpOnly signed cookie (server-side auth gate for approve/payout routes)
    try {
      await fetch("/api/auth/set-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
        credentials: "same-origin",
      });
    } catch {
      // Non-fatal: continue even if cookie set fails (e.g. ROLE_COOKIE_SECRET not configured)
      console.warn("[role-switcher] Failed to set role cookie — payout routes may reject");
    }

    // Also persist in localStorage for client-side UI hints
    if (typeof window !== "undefined") {
      localStorage.setItem("consultai_role", role);
    }

    if (role === "company") {
      router.push("/dashboard");
    } else {
      router.push("/demo-inbox");
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-4 py-16">
      <div className="text-center space-y-2">
        <h1 className="text-4xl font-bold tracking-tight">ConsultAI</h1>
        <p className="text-muted-foreground text-lg max-w-md">
          AI-agent platform matching companies with vetted freelance consultants.
          PayPal-rails milestone payments.
        </p>
        <p className="text-xs text-muted-foreground mt-1 border rounded px-2 py-1 inline-block">
          Demo auth — role cookie is signed but not production auth
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <button
          onClick={() => selectRole("company")}
          className="rounded-xl border-2 border-primary bg-primary text-primary-foreground px-10 py-6 text-xl font-semibold hover:opacity-90 transition-opacity"
        >
          🏢 I&apos;m a Company
        </button>
        <button
          onClick={() => selectRole("freelancer")}
          className="rounded-xl border-2 border-border bg-card text-card-foreground px-10 py-6 text-xl font-semibold hover:bg-muted transition-colors"
        >
          💼 I&apos;m a Freelancer
        </button>
      </div>

      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
    </main>
  );
}
