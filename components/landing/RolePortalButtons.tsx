"use client";

import { useRouter } from "next/navigation";

interface RolePortalButtonsProps {
  /**
   * Server-resolved presentation mode. Demo mode keeps instant role
   * switching via /api/auth/set-role; live mode must never call it
   * (the endpoint is blocked there by design) and routes to sign-in,
   * where the session establishes the authoritative role.
   */
  demoMode: boolean;
}

/**
 * Landing role-portal buttons (client island).
 *
 * Extracted from app/page.tsx so the page can stay a server component and
 * resolve demo-vs-live at request time. Calling set-role unconditionally
 * produced a 403 on every production portal click and then pushed into an
 * unauthenticated dashboard; live clicks now go straight to /login.
 */
export function RolePortalButtons({ demoMode }: RolePortalButtonsProps) {
  const router = useRouter();

  async function selectRole(role: "company" | "freelancer" | "admin") {
    if (!demoMode) {
      router.push("/login");
      return;
    }
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
    <>
      {/* Company Portal */}
      <button
        type="button"
        onClick={() => void selectRole("company")}
        className="interactive-card-lift group flex flex-col justify-between rounded-xl border border-blue-500/50 bg-[#0f1626] p-5 text-left shadow-lg transition-all hover:border-blue-400"
      >
        <div>
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/15 px-2.5 py-1 font-mono text-[11px] font-semibold text-blue-300">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
              Client Workspace
            </span>
            <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01" />
            </svg>
          </div>
          <h3 className="mt-4 text-lg font-bold text-white">Company Portal</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
            Manage consulting projects, Bryntum Gantt critical paths, AG Grid operations, AI Supervisor workflows, and authorize milestone payouts.
          </p>
        </div>
        <div className="mt-5 flex items-center justify-between border-t border-slate-800/90 pt-3 text-xs font-semibold text-blue-300">
          <span>Enter Company Dashboard</span>
          <span className="transition-transform group-hover:translate-x-1">→</span>
        </div>
      </button>

      {/* Freelancer Portal */}
      <button
        type="button"
        onClick={() => void selectRole("freelancer")}
        className="interactive-card-lift group flex flex-col justify-between rounded-xl border border-slate-800 bg-[#0f141e] p-5 text-left shadow-lg transition-all hover:border-emerald-500/50"
      >
        <div>
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Consultant Portal
            </span>
            <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
          </div>
          <h3 className="mt-4 text-lg font-bold text-white">Freelancer Portal</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
            Track active assignments, upcoming milestone deadlines, verified earnings, NDA invitations, and submit GitHub PR deliverables.
          </p>
        </div>
        <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-3 text-xs font-semibold text-emerald-400">
          <span>Enter Consultant Workspace</span>
          <span className="transition-transform group-hover:translate-x-1">→</span>
        </div>
      </button>

      {/* Administrator Portal */}
      <button
        type="button"
        onClick={() => void selectRole("admin")}
        className="interactive-card-lift group flex flex-col justify-between rounded-xl border border-slate-800 bg-[#0f141e] p-5 text-left shadow-lg transition-all hover:border-cyan-500/50"
      >
        <div>
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-cyan-300">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
              Governance &amp; Audit
            </span>
            <svg className="h-5 w-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <h3 className="mt-4 text-lg font-bold text-white">Administrator</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
            Monitor platform-wide transactions, active PayPal disputes, multi-agent execution telemetry, demo reset controls, and append-only audit logs.
          </p>
        </div>
        <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-3 text-xs font-semibold text-cyan-400">
          <span>Enter Admin Governance</span>
          <span className="transition-transform group-hover:translate-x-1">→</span>
        </div>
      </button>
    </>
  );
}
