"use client";

import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/shared/ThemeToggle";

/**
 * ConsultAI Enterprise Landing & Role Switcher (Section 9)
 *
 * Differentiated experiences for:
 * - Company Operators (`/dashboard`, `/planning`, `/operations`, `/ai-ops`)
 * - Freelance Consultants (`/freelancer`, `/demo-inbox`, `/deliver/[milestoneId]`)
 * - Platform Administrators (`/admin`, `/ai-ops`, `/operations`)
 */
export default function HomePage() {
  const router = useRouter();

  async function selectRole(role: "company" | "freelancer" | "admin") {
    try {
      await fetch("/api/auth/set-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
        credentials: "same-origin",
      });
    } catch {
      console.warn("[role-switcher] Failed to set role cookie");
    }

    if (typeof window !== "undefined") {
      localStorage.setItem("consultai_role", role);
    }

    if (role === "company") {
      router.push("/dashboard");
    } else if (role === "freelancer") {
      router.push("/freelancer");
    } else {
      router.push("/admin");
    }
  }

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-12 overflow-hidden bg-slate-950 px-4 py-16 text-slate-100">
      {/* Subtle background grid pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      {/* Glow accent */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 h-[420px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600/10 blur-3xl" />

      {/* Hero text */}
      <div className="relative z-10 max-w-2xl space-y-4 text-center">
        <div className="inline-flex items-center gap-2.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-3.5 py-1 text-xs font-semibold text-blue-300">
          <span>✦ PydanticAI Multi-Agent Orchestration</span>
          <span>•</span>
          <span>6-Stage PayPal Escrow Security</span>
        </div>

        <div className="flex items-center justify-center gap-3 pt-2">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-base font-bold text-white shadow-lg shadow-blue-600/30">
            CA
          </span>
          <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
            ConsultAI
          </h1>
        </div>

        <p className="mx-auto max-w-xl text-base leading-relaxed text-slate-400">
          Enterprise multi-agent consulting &amp; project management platform.
          Coordinated Supervisor AI, Bryntum Gantt critical-path scheduling, AG Grid operations,
          and human-gated PayPal milestone payouts.
        </p>
      </div>

      {/* Differentiated Role Cards (Company, Freelancer, Administrator) */}
      <div className="relative z-10 grid w-full max-w-4xl grid-cols-1 gap-4 md:grid-cols-3">
        <button
          type="button"
          onClick={() => void selectRole("company")}
          className="group flex flex-col justify-between rounded-2xl border-2 border-blue-500 bg-blue-600/15 p-6 text-left shadow-xl shadow-blue-950/30 transition-all hover:bg-blue-600/25 active:scale-[0.99]"
        >
          <div>
            <div className="flex items-center justify-between">
              <span className="rounded-lg bg-blue-600 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-white">
                Client Workspace
              </span>
              <span className="text-2xl">🏢</span>
            </div>
            <h2 className="mt-4 text-xl font-bold text-white">Company Portal</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
              Manage projects, Bryntum Gantt schedules, AG Grid operations, AI Supervisor workflows, and authorize milestone payouts.
            </p>
          </div>
          <div className="mt-5 flex items-center justify-between border-t border-blue-500/30 pt-3 text-xs font-semibold text-blue-300">
            <span>Enter Company Dashboard</span>
            <span className="transition-transform group-hover:translate-x-1">→</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => void selectRole("freelancer")}
          className="group flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/90 p-6 text-left shadow-xl transition-all hover:border-emerald-500/50 hover:bg-slate-900 active:scale-[0.99]"
        >
          <div>
            <div className="flex items-center justify-between">
              <span className="rounded-lg bg-emerald-500/20 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-emerald-300">
                Consultant Portal
              </span>
              <span className="text-2xl">💼</span>
            </div>
            <h2 className="mt-4 text-xl font-bold text-white">Freelancer Portal</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              Track active assignments, upcoming deadlines, verified earnings, availability status, NDA invitations, and submit PR deliverables.
            </p>
          </div>
          <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-3 text-xs font-semibold text-emerald-400">
            <span>Enter Consultant Workspace</span>
            <span className="transition-transform group-hover:translate-x-1">→</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => void selectRole("admin")}
          className="group flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/90 p-6 text-left shadow-xl transition-all hover:border-purple-500/50 hover:bg-slate-900 active:scale-[0.99]"
        >
          <div>
            <div className="flex items-center justify-between">
              <span className="rounded-lg bg-purple-500/20 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-purple-300">
                Governance &amp; Audit
              </span>
              <span className="text-2xl">🛡️</span>
            </div>
            <h2 className="mt-4 text-xl font-bold text-white">Administrator</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              Monitor platform-wide transactions, active PayPal disputes, multi-agent execution telemetry, and append-only security audit logs.
            </p>
          </div>
          <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-3 text-xs font-semibold text-purple-400">
            <span>Enter Admin Governance</span>
            <span className="transition-transform group-hover:translate-x-1">→</span>
          </div>
        </button>
      </div>

      {/* Feature pills */}
      <div className="relative z-10 flex flex-wrap items-center justify-center gap-2">
        {[
          "PydanticAI Supervisor + 5 Specialist Agents",
          "Bryntum Gantt Critical Path & Baselines",
          "AG Grid 7-Domain Operations",
          "6-Stage PayPal Escrow Security",
          "Live SSE AI Operations Center",
        ].map((f) => (
          <span
            key={f}
            className="rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1 text-xs text-slate-400"
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
