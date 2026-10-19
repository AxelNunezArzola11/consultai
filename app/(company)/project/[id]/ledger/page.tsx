export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
// FinancialLedgerView is a client component that wraps the AG Grid with its own
// dynamic import (ssr: false). We import it directly here — the ssr:false is
// applied inside FinancialLedgerView.tsx, not at the page level.
import { FinancialLedgerView } from "@/components/canvas/FinancialLedgerView";

export default async function FinancialLedgerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [project] = await db
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (!project) notFound();

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{project.title}</h1>
        <p className="text-muted-foreground text-sm mt-1">Financial Ledger</p>
      </div>

      <div className="rounded-xl border overflow-hidden bg-card">
        <div className="px-4 py-3 border-b bg-muted/30">
          <p className="text-sm font-medium">Milestone Payments</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Filter, sort, and group by status, budget, or consultant. Click column headers to sort.
          </p>
        </div>
        <div className="p-0">
          <FinancialLedgerView projectId={id} />
        </div>
      </div>
    </div>
  );
}
