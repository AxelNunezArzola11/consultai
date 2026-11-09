/**
 * AG Studio Analytics — Server Component (route: /analytics)
 *
 * This page is completely isolated from the main /dashboard route.
 * It:
 *   1. Fetches raw milestones + payment join rows from the DB.
 *   2. Fetches candidate rows.
 *   3. Shapes them into an AgDataSourcesDefinition via buildStudioData().
 *   4. Passes the result to the <AgStudioDashboard> client component.
 *
 * No AG Studio imports happen here — only data fetching and shaping.
 */
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { milestones, payments, candidates, projects } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";

import { buildStudioData, type InvoiceRow, type CustomerRow } from "@/components/ag-studio-dashboard/data";
import AgStudioDashboard from "@/components/ag-studio-dashboard/Dashboard";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { requirePageRole, scopedCompanyId } from "@/lib/auth/guards";

export default async function AnalyticsPage() {
  // Authenticate + authorize BEFORE querying/rendering (demo bypass: fixtures only).
  const auth = await requirePageRole(["company", "admin"]);
  const scope = scopedCompanyId(auth);
  const demoTables = isDemoMode() ? getDemoTables() : null;
  // Live company scope: restrict every table to the caller's own projects.
  const ownProjectIds =
    !demoTables && scope
      ? (
          await db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.companyId, scope))
        ).map((r) => r.id)
      : null;
  // ── 1. Fetch invoice rows (milestones LEFT JOIN payments) ─────────────────
  const milestoneRows = demoTables
    ? demoTables.milestones.slice(0, 500)
    : ownProjectIds
      ? ownProjectIds.length > 0
        ? await db
            .select()
            .from(milestones)
            .where(inArray(milestones.projectId, ownProjectIds))
            .limit(500)
        : []
      : await db.select().from(milestones).limit(500);

  // Build a lookup of candidate_id per milestone via the payments table
  const scopedMilestoneIds = ownProjectIds ? milestoneRows.map((m) => m.id) : null;
  const paymentRows = demoTables
    ? demoTables.payments.slice(0, 500)
    : scopedMilestoneIds
      ? scopedMilestoneIds.length > 0
        ? await db
            .select()
            .from(payments)
            .where(inArray(payments.milestoneId, scopedMilestoneIds))
            .limit(500)
        : []
      : await db.select().from(payments).limit(500);
  const paymentByMilestone = new Map(
    paymentRows.map((p) => [p.milestoneId, p])
  );

  const invoiceRows: InvoiceRow[] = milestoneRows.map((m) => {
    const pmt = paymentByMilestone.get(m.id);
    return {
      id:               m.id,
      projectId:        m.projectId,
      title:            m.title,
      status:           m.status,
      budgetUsd:        m.budgetUsd,
      captureGrossUsd:  m.captureGrossUsd,
      captureFeeUsd:    m.captureFeeUsd,
      captureNetUsd:    m.captureNetUsd,
      currency:         m.currency,
      dueDate:          m.dueDate,
      createdAt:        m.createdAt.toISOString(),
      candidateId:      pmt?.candidateId ?? null,
      paymentStatus:    pmt?.status ?? null,
    };
  });

  // ── 2. Fetch customer rows (candidates) ───────────────────────────────────
  const candidateRows = demoTables
    ? demoTables.candidates.slice(0, 500)
    : ownProjectIds
      ? ownProjectIds.length > 0
        ? await db
            .select()
            .from(candidates)
            .where(inArray(candidates.projectId, ownProjectIds))
            .limit(500)
        : []
      : await db.select().from(candidates).limit(500);

  const customerRows: CustomerRow[] = candidateRows.map((c) => ({
    id:         c.id,
    name:       c.name,
    email:      c.email,
    status:     c.status,
    trustScore: c.trustScore,
    rank:       c.rank,
    createdAt:  c.createdAt.toISOString(),
  }));

  // ── 3. Build the AG Studio data definition ────────────────────────────────
  const studioData = buildStudioData(invoiceRows, customerRows);

  // ── 4. Render ─────────────────────────────────────────────────────────────
  // Normal flow inside the shared company layout (header + main) — no fixed
  // overlay, so the page scrolls and resizes with the rest of the app.
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col space-y-4 px-6 py-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-white">
          Analytics
        </h1>
        <p className="mt-0.5 text-xs text-slate-400">
          Milestone invoices and consultant activity, powered by AG Studio
          dashboards.
        </p>
      </div>
      <div className="min-h-[70vh] flex-1 overflow-hidden rounded-2xl border border-slate-800 bg-[#0a0e18]">
        {/*
          AgStudioDashboard is a "use client" component. It receives plain
          serialisable props from this server component — no DB references
          are passed across the boundary.
        */}
        <AgStudioDashboard studioData={studioData} />
      </div>
    </div>
  );
}
