"use client";

import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/shared/ThemeToggle";

/**
 * Role switcher — landing page.
 *
 * Visual: AG Studio Midnight hero — dark slate bg, blue primary, clean typography.
 * Sets a signed, httpOnly role cookie via POST /api/auth/set-role
 * (demo auth — not production auth; documented in lib/auth/role-cookie.ts).
 * Also stores the role in localStorage for client-side UI hints.
 */
export default function HomePage() {
  const router = useRouter();

  async function selectRole(role: "company" | "freelancer") {
    try {
      await fetch("/api/auth/set-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
        credentials: "same-origin",
      });
    } catch {
      console.warn("[role-switcher] Failed to set role cookie — payout routes may reject");
    }

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
    <main className="flex flex-1 flex-col items-center justify-center gap-12 px-4 py-20 relative overflow-hidden">
      {/* Subtle background grid pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04] dark:opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      {/* Glow accent */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-primary/5 blur-3xl" />

      {/* Hero text */}
      <div className="text-center space-y-4 relative z-10">
        <div className="inline-flex items-center gap-2 mb-2">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground text-sm font-bold shadow-lg shadow-primary/30">
            CA
          </span>
          <span className="text-4xl font-bold tracking-tight">ConsultAI</span>
        </div>
        <p className="text-muted-foreground text-lg max-w-md leading-relaxed">
          AI-agent platform matching companies with vetted freelance consultants.
          PayPal-rails milestone payments.
        </p>
        <div className="flex items-center justify-center gap-2 mt-2">
          <span className="text-xs text-muted-foreground border border-border bg-muted/40 px-3 py-1.5 rounded-full">
            Demo auth — role cookie is signed but not production auth
          </span>
        </div>
      </div>

      {/* Role buttons */}
      <div className="flex flex-col sm:flex-row gap-4 relative z-10">
        <button
          onClick={() => selectRole("company")}
          className="group relative overflow-hidden rounded-2xl border-2 border-primary bg-primary text-primary-foreground px-10 py-6 text-lg font-semibold shadow-lg shadow-primary/20 hover:shadow-primary/40 hover:brightness-110 active:scale-[0.97] transition-all duration-200"
        >
          <span className="relative z-10 flex flex-col items-center gap-1">
            <span className="text-3xl">🏢</span>
            <span>I&apos;m a Company</span>
            <span className="text-xs font-normal opacity-75">Hire vetted consultants</span>
          </span>
        </button>

        <button
          onClick={() => selectRole("freelancer")}
          className="group rounded-2xl border-2 border-border bg-card text-card-foreground px-10 py-6 text-lg font-semibold shadow-md hover:border-primary/50 hover:shadow-lg hover:bg-muted/50 active:scale-[0.97] transition-all duration-200"
        >
          <span className="flex flex-col items-center gap-1">
            <span className="text-3xl">💼</span>
            <span>I&apos;m a Freelancer</span>
            <span className="text-xs font-normal text-muted-foreground">Find projects &amp; get paid</span>
          </span>
        </button>
      </div>

      {/* Feature pills */}
      <div className="flex flex-wrap items-center justify-center gap-2 relative z-10">
        {["AG Grid · AG Charts", "Bryntum Gantt", "PayPal Payments", "AI Vetting"].map((f) => (
          <span
            key={f}
            className="text-xs text-muted-foreground bg-muted/50 border border-border px-3 py-1 rounded-full"
          >
            {f}
          </span>
        ))}
      </div>

      <div className="absolute top-4 right-4 z-50">
        <ThemeToggle />
      </div>
    </main>
  );
}
