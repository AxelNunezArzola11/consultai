/**
 * DemoControlCenter — presentation command post, embedded in /admin.
 *
 * Shows the active mode, live system health, the eight demo scenarios with
 * direct links, portal navigation, demo reset (demo mode only), and the
 * entry point for the consolidated multi-agent demonstration.
 */

import Link from "next/link";
import { isDemoMode, DEMO_IDS } from "@/lib/demo/config";
import { getSystemHealth, type SystemStatus } from "@/lib/demo/health";
import { DemoResetButton } from "./DemoResetButton";

const STATUS_STYLES: Record<SystemStatus, string> = {
  connected: "border-emerald-500/40 bg-emerald-950/40 text-emerald-300",
  degraded: "border-amber-500/40 bg-amber-950/40 text-amber-300",
  unavailable: "border-red-500/40 bg-red-950/40 text-red-300",
  simulated: "border-sky-500/40 bg-sky-950/40 text-sky-300",
};

interface Props {
  projectId: string;
  disputePath: string | null;
  deliverPath: string | null;
}

export async function DemoControlCenter({
  projectId,
  disputePath,
  deliverPath,
}: Props) {
  const demo = isDemoMode();
  const health = await getSystemHealth().catch(() => null);
  const status: SystemStatus = health?.status ?? (demo ? "simulated" : "unavailable");

  const scenarios: Array<{ id: string; title: string; href: string; hint: string }> = [
    { id: "A", title: "Create & manage a project", href: "/project/new", hint: "Start form → AI planner → workspace" },
    { id: "B", title: "AI planning", href: `/planning?projectId=${projectId}`, hint: "Plan, Gantt timeline, edit & approve tasks" },
    { id: "C", title: "Talent & candidate vetting", href: `/project/${projectId}/vetting`, hint: "Search, evaluate, shortlist, send NDA" },
    { id: "D", title: "Delivery & verification", href: deliverPath ?? `/project/${projectId}/delivery`, hint: "Submit PR → verify → review runs" },
    { id: "E", title: "Rescheduling", href: `/planning?projectId=${projectId}`, hint: "3-day delay → proposal → human approval" },
    { id: "F", title: "Financial workflow", href: `/project/${projectId}/approvals`, hint: "Budget → proposal → approval → payout gate" },
    { id: "G", title: "Dispute management", href: disputePath ?? `/project/${projectId}/milestones`, hint: "Evidence, status, role-scoped actions" },
    { id: "H", title: "Multi-agent orchestration", href: `/ai-ops?projectId=${projectId}`, hint: "Supervisor + 5 specialists, consolidated report" },
  ];

  return (
    <section
      aria-label="Demo Control Center"
      className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Demo Control Center</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {demo
              ? "OFFLINE DEMO MODE — fictional TechNova scenario. All data, transactions, and agent runs are simulated."
              : "LIVE MODE — real database and integrations. PayPal Sandbox for payments."}
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_STYLES[status]}`}
        >
          {status.toUpperCase()}
          {health?.latencyMs != null && status !== "simulated"
            ? ` · ${health.latencyMs}ms`
            : ""}
        </span>
      </div>

      {health && (
        <p className="mt-2 text-xs text-slate-400">{health.detail}</p>
      )}
      {health && health.status !== "simulated" && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {(Object.entries(health.checks) as Array<[string, string]>).map(([k, v]) => (
            <span
              key={k}
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-300"
            >
              {k}: <strong>{v}</strong>
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {scenarios.map((s) => (
          <Link
            key={s.id}
            href={s.href}
            className="group rounded-xl border border-slate-800 bg-slate-950/60 p-3 transition-colors hover:border-slate-600"
          >
            <p className="text-xs font-bold text-blue-300">Scenario {s.id}</p>
            <p className="mt-0.5 text-sm font-medium text-white group-hover:underline">
              {s.title}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">{s.hint}</p>
          </Link>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-start gap-6 border-t border-slate-800 pt-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-300">Portals</p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link href="/dashboard" className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800">Company</Link>
            <Link href="/freelancer" className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800">Freelancer</Link>
            <Link href="/admin" className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800">Admin</Link>
            <Link href="/operations" className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800">Operations</Link>
            <Link href="/demo-inbox" className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800">NDA Inbox</Link>
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-300">Multi-agent demo</p>
          <Link
            href={`/ai-ops?projectId=${projectId}`}
            className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
          >
            Open AI Ops Center — run consolidated review
          </Link>
          <p className="max-w-xs text-xs text-slate-500">
            Supervisor coordinates Planning, Talent, Delivery, Finance, and Reschedule agents.
            {demo ? " Runs are deterministic simulations." : " Requires AI provider credentials."}
          </p>
        </div>
        {demo && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-300">Fixtures</p>
            <DemoResetButton />
          </div>
        )}
      </div>
    </section>
  );
}

export function demoProjectId(): string {
  return DEMO_IDS.project;
}
