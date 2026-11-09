import Link from "next/link";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import { RolePortalButtons } from "@/components/landing/RolePortalButtons";
import { isDemoMode } from "@/lib/demo/config";

/**
 * ConsultAI Enterprise Landing & Role Switcher (Section 9)
 *
 * Differentiated experiences for:
 * - Company Operators (`/dashboard`, `/planning`, `/operations`, `/ai-ops`)
 * - Freelance Consultants (`/freelancer`, `/demo-inbox`, `/deliver/[milestoneId]`)
 * - Platform Administrators (`/admin`, `/ai-ops`, `/operations`)
 *
 * Server component: resolves demo-vs-live at request time for the
 * <RolePortalButtons> client island (demo keeps instant role switching;
 * live routes portal clicks to /login since set-role is blocked there).
 * force-dynamic: DEMO_MODE is runtime env and the same build serves both
 * modes, so a prerendered flag would be wrong for one of them.
 */
export const dynamic = "force-dynamic";

export default function HomePage() {
  const demoMode = isDemoMode();

  return (
    <main className="relative flex flex-1 flex-col justify-between overflow-hidden bg-[#090c12] text-slate-100">
      {/* Top Enterprise Header Bar */}
      <header className="relative z-20 border-b border-slate-800/80 bg-[#0b0f17]/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 font-mono text-xs font-bold text-white shadow-sm shadow-blue-600/30">
              CA
            </span>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight text-white">ConsultAI</span>
              <span className="hidden sm:inline-block rounded border border-slate-700/80 bg-slate-900 px-2 py-0.5 font-mono text-[10px] font-medium text-slate-300">
                Enterprise Consulting &amp; Escrow OS
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <Link
              href="/login"
              data-testid="landing-sign-in"
              className="rounded-lg border border-slate-700/80 bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
            >
              Sign In to Account
            </Link>
            <Link
              href="/register/company"
              data-testid="landing-register-company"
              className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm shadow-blue-600/25 transition hover:bg-blue-500"
            >
              Register as a Company
            </Link>
            <Link
              href="/register/freelancer"
              data-testid="landing-register-freelancer"
              className="hidden sm:inline-flex rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/20"
            >
              Join as a Freelancer
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-10 px-6 py-12">
        {/* Hero Split: Value Proposition + Live Product Telemetry Frame */}
        <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-7">
            <div className="inline-flex items-center gap-2 rounded-md border border-blue-500/25 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-300">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
              <span>Multi-Agent Consulting Operations &amp; Human-Gated PayPal Escrow</span>
            </div>

            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-5xl sm:leading-[1.12]">
              Scope, vet, schedule, and release consulting milestones with verified evidence.
            </h1>

            <p className="max-w-2xl text-base leading-relaxed text-slate-300">
              ConsultAI coordinates a Supervisor AI and five specialist agents with{" "}
              <strong className="font-semibold text-white">Bryntum Gantt</strong> critical-path scheduling,{" "}
              <strong className="font-semibold text-white">AG Grid</strong> operational ledgers, GitHub-verified
              talent vetting, and 6-stage PayPal milestone escrow.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-1 sm:hidden">
              <Link
                href="/register/freelancer"
                className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2 text-xs font-semibold text-emerald-300"
              >
                Join as a Freelancer
              </Link>
            </div>

            {/* Key Quantitative Capabilities Bar */}
            <div className="grid grid-cols-3 gap-4 border-t border-slate-800/90 pt-5">
              <div>
                <div className="font-mono text-xl font-bold tabular-nums text-white">6 Agents</div>
                <div className="mt-0.5 text-xs text-slate-400">Supervisor + 5 Specialists</div>
              </div>
              <div>
                <div className="font-mono text-xl font-bold tabular-nums text-emerald-400">100% Gated</div>
                <div className="mt-0.5 text-xs text-slate-400">Human payout &amp; schedule sign-off</div>
              </div>
              <div>
                <div className="font-mono text-xl font-bold tabular-nums text-blue-400">SHA-256</div>
                <div className="mt-0.5 text-xs text-slate-400">NDA &amp; PR commit binding</div>
              </div>
            </div>
          </div>

          {/* Live Product UI Preview Window (design-taste-frontend: show the real product UI) */}
          <div className="lg:col-span-5">
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0f141e] shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800 bg-[#0b0f17] px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="font-mono text-xs font-medium text-slate-200">
                    Active Engagement · TechNova SaaS
                  </span>
                </div>
                <span className="rounded border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-blue-300">
                  ESCROW ACTIVE
                </span>
              </div>

              <div className="space-y-3 p-4 text-xs">
                <div className="flex items-center justify-between rounded-lg border border-slate-800/90 bg-[#0b0f17] px-3 py-2.5">
                  <div>
                    <div className="font-medium text-white">1. Requirements &amp; Architecture</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">Verified PR #42 · Maya Chen (@maya-chen-demo)</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-semibold tabular-nums text-emerald-400">$4,000</div>
                    <div className="text-[10px] text-emerald-400/80">Released</div>
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-blue-500/30 bg-blue-950/20 px-3 py-2.5">
                  <div>
                    <div className="font-medium text-white">2. Frontend Development</div>
                    <div className="mt-0.5 text-[11px] text-slate-300">PayPal Order Captured · Awaiting PR</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-semibold tabular-nums text-blue-300">$5,500</div>
                    <div className="text-[10px] text-blue-300/80">Held in Escrow</div>
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2.5">
                  <div>
                    <div className="font-medium text-white">3. Backend Development</div>
                    <div className="mt-0.5 text-[11px] text-slate-300">Delivery Agent Verified · Human Gate</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-semibold tabular-nums text-amber-300">$6,000</div>
                    <div className="text-[10px] text-amber-300/80">Pending Approval</div>
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-slate-800/80 pt-2.5 text-[11px] text-slate-400">
                  <span>Critical Path: 6 Milestones · 3 Vetted Consultants</span>
                  <span className="font-mono font-semibold tabular-nums text-slate-200">$25,000 Total</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Differentiated Role Portals (Company, Freelancer, Administrator) */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">
              Select Workspace Role to Enter Platform
            </h2>
            <span className="text-xs text-slate-400">
              {demoMode
                ? "Instant role switching for evaluation & live workflows"
                : "Sign in to enter your workspace"}
            </span>
          </div>

          <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-3">
            <RolePortalButtons demoMode={demoMode} />
          </div>
        </div>
      </div>

      {/* Footer Architecture Strip */}
      <footer className="relative z-10 border-t border-slate-800/80 bg-[#0b0f17] px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <span>ConsultAI Enterprise Platform · Role-Isolated Sessions &amp; Human-Gated Escrow</span>
          <div className="flex flex-wrap items-center gap-2">
            {[
              "PydanticAI Supervisor",
              "Bryntum Gantt WBS",
              "AG Grid 7-Domain Ops",
              "PayPal Orders & Payouts",
            ].map((item) => (
              <span
                key={item}
                className="rounded border border-slate-800 bg-slate-900/90 px-2.5 py-0.5 text-[11px] text-slate-300"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      </footer>
    </main>
  );
}
