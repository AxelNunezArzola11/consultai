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
import { milestones, payments, candidates } from "@/lib/db/schema";

import { buildStudioData, type InvoiceRow, type CustomerRow } from "@/components/ag-studio-dashboard/data";
import AgStudioDashboard from "@/components/ag-studio-dashboard/Dashboard";

export default async function AnalyticsPage() {
  // ── 1. Fetch invoice rows (milestones LEFT JOIN payments) ─────────────────
  const milestoneRows = await db.select().from(milestones).limit(500);

  // Build a lookup of candidate_id per milestone via the payments table
  const paymentRows = await db.select().from(payments).limit(500);
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
  const candidateRows = await db.select().from(candidates).limit(500);

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
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Offset for the shared sidebar/navbar — adjust to match your layout
        top:  "var(--nav-height, 56px)",
        left: "var(--sidebar-width, 64px)",
        background: "#0a0e18",
        zIndex: 10,
      }}
    >
      {/*
        AgStudioDashboard is a "use client" component. It receives plain
        serialisable props from this server component — no DB references
        are passed across the boundary.
      */}
      <AgStudioDashboard studioData={studioData} />
    </div>
  );
}
