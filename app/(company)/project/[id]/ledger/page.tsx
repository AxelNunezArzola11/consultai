export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
// FinancialLedgerView is a client component that wraps the AG Grid with its own
// dynamic import (ssr: false). We import it directly here — the ssr:false is
// applied inside FinancialLedgerView.tsx, not at the page level.
import { FinancialLedgerView } from "@/components/canvas/FinancialLedgerView";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { requireProjectAccess } from "@/lib/auth/guards";

export default async function FinancialLedgerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Role gate + company ownership (live); cross-company -> notFound, before any query.
  await requireProjectAccess(id);

  const demoTables = isDemoMode() ? getDemoTables() : null;

  const project = demoTables
    ? demoTables.projects.find((p) => p.id === id)
    : (
        await db
          .select({ id: projects.id, title: projects.title })
          .from(projects)
          .where(eq(projects.id, id))
          .limit(1)
      )[0];

  if (!project) notFound();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{project.title}</h1>
          <p className="mt-1 text-xs text-slate-400">
            Financial Ledger · PayPal Orders &amp; Payouts Reconciliation Grid
          </p>
        </div>
        <span className="rounded border border-slate-800 bg-slate-900 px-2.5 py-1 font-mono text-[11px] text-slate-300">
          AG Grid Financial Ledger
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0f141e]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 bg-[#090c12]/60 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-white">Milestone Payments</p>
            <p className="mt-0.5 text-xs text-slate-400">
              Filter, sort, and group by status, budget, or consultant. Click column headers to sort.
            </p>
          </div>
          <span className="font-mono text-[11px] text-slate-400">USD · Tabular Precision</span>
        </div>
        <div className="p-0">
          <FinancialLedgerView projectId={id} />
        </div>
      </div>
    </div>
  );
}
