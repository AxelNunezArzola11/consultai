import Link from "next/link";

export default function RegisterChoicePage() {
  return (
    <div className="min-h-screen bg-[#090c12] text-slate-100 flex flex-col justify-between">
      <header className="border-b border-slate-800/90 bg-[#090c12]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600 font-mono text-xs font-bold text-white shadow-sm shadow-blue-600/30">
              CA
            </span>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-white">ConsultAI</span>
              <span className="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-400">
                v4.2
              </span>
            </div>
          </Link>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-400">Already registered?</span>
            <Link
              href="/login"
              className="rounded-md border border-slate-700 bg-slate-900 px-3.5 py-1.5 font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
            >
              Sign In →
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-12">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Choose your ConsultAI account type
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-400">
            ConsultAI isolates Company client organizations from independent Freelancer
            and Consultant profiles with strict role-based access control.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Company Option */}
          <div className="interactive-card-lift flex flex-col justify-between rounded-xl border border-slate-800 bg-[#0f141e] p-7 shadow-xl transition hover:border-blue-500/50">
            <div>
              <div className="flex items-center justify-between">
                <span className="rounded border border-blue-500/25 bg-blue-500/10 px-2.5 py-1 font-mono text-xs font-semibold uppercase text-blue-300">
                  Company / Client
                </span>
                <span className="font-mono text-xs text-slate-400">Hiring &amp; Delivery</span>
              </div>
              <h2 className="mt-4 text-xl font-bold tracking-tight text-white">
                Register a Company Workspace
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                For engineering leaders, product teams, and enterprises commissioning
                software delivery, AI systems, and technical consulting.
              </p>
              <ul className="mt-5 space-y-2 text-xs text-slate-300">
                <li className="flex items-center gap-2">
                  <span className="text-blue-400">✓</span> AI Brief scoping &amp; Bryntum Gantt WBS planning
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-blue-400">✓</span> GitHub signal-verified consultant vetting
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-blue-400">✓</span> One-click NDA generation &amp; cryptographic tracking
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-blue-400">✓</span> Human-gated PayPal milestone escrow &amp; dispute desk
                </li>
              </ul>
            </div>

            <div className="mt-7">
              <Link
                href="/register/company"
                data-testid="choose-register-company"
                className="block w-full rounded-lg bg-blue-600 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-500"
              >
                Continue as Company →
              </Link>
            </div>
          </div>

          {/* Freelancer Option */}
          <div className="interactive-card-lift flex flex-col justify-between rounded-xl border border-slate-800 bg-[#0f141e] p-7 shadow-xl transition hover:border-emerald-500/50">
            <div>
              <div className="flex items-center justify-between">
                <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 font-mono text-xs font-semibold uppercase text-emerald-300">
                  Freelancer / Consultant
                </span>
                <span className="font-mono text-xs text-slate-400">Execution &amp; Payouts</span>
              </div>
              <h2 className="mt-4 text-xl font-bold tracking-tight text-white">
                Register a Consultant Profile
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                For independent engineers, AI specialists, and technical consultants
                delivering milestone-backed software engagements.
              </p>
              <ul className="mt-5 space-y-2 text-xs text-slate-300">
                <li className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Connect canonical GitHub handle for automated vetting
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Review &amp; digitally sign project NDAs
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Submit GitHub PR deliverables against acceptance criteria
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Track escrow verification &amp; instant milestone payouts
                </li>
              </ul>
            </div>

            <div className="mt-7">
              <Link
                href="/register/freelancer"
                data-testid="choose-register-freelancer"
                className="block w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm shadow-emerald-600/20 transition hover:bg-emerald-500"
              >
                Continue as Freelancer →
              </Link>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-800/80 py-4 text-center text-xs text-slate-400">
        ConsultAI Enterprise Platform · Secure Role-Isolated Onboarding
      </footer>
    </div>
  );
}
