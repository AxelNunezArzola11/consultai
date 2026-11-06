export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import {
  candidates,
  milestones,
  projects,
  payments,
  ndas,
  verificationRuns,
} from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { withTimeout } from "@/lib/db/with-timeout";
import { DbStatusBanner } from "@/components/demo/DbStatusBanner";

/**
 * Freelancer Consultant Dashboard — Section 9 Differentiated Freelancer Experience
 *
 * Connected to real Neon PostgreSQL tables:
 * - Active assignments (`candidates` + `projects`)
 * - Upcoming deadlines (`milestones`)
 * - Verified Earnings (`payments` succeeded / `milestones` paid)
 * - Pending payments (funded / in_verification / pending_approval)
 * - Consultant availability & trust score telemetry
 * - Deliverables & PR verification status (`/deliver/[milestoneId]`)
 */
export default async function FreelancerDashboardPage() {
  const demoTables = isDemoMode() ? getDemoTables() : null;
  let degraded: string | null = null;
  let candidateRows: Array<typeof candidates.$inferSelect> = [];
  let projectRows: Array<typeof projects.$inferSelect> = [];
  let milestoneRows: Array<typeof milestones.$inferSelect> = [];
  let paymentRows: Array<typeof payments.$inferSelect> = [];
  let ndaRows: Array<typeof ndas.$inferSelect> = [];
  let verifRows: Array<typeof verificationRuns.$inferSelect> = [];

  if (demoTables) {
    candidateRows = [...demoTables.candidates].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    projectRows = [...demoTables.projects].sort((a, b) => +b.createdAt - +a.createdAt);
    milestoneRows = [...demoTables.milestones].sort((a, b) => a.position - b.position);
    paymentRows = [...demoTables.payments].sort((a, b) => +b.createdAt - +a.createdAt);
    ndaRows = [...demoTables.ndas].sort((a, b) => +b.createdAt - +a.createdAt);
    verifRows = [...demoTables.verificationRuns]
      .sort((a, b) => +b.createdAt - +a.createdAt)
      .slice(0, 15);
  } else {
    try {
      [
        candidateRows,
        projectRows,
        milestoneRows,
        paymentRows,
        ndaRows,
        verifRows,
      ] = await withTimeout(
        Promise.all([
          db.select().from(candidates).orderBy(candidates.rank),
          db.select().from(projects).orderBy(desc(projects.createdAt)),
          db.select().from(milestones).orderBy(milestones.position),
          db.select().from(payments).orderBy(desc(payments.createdAt)),
          db.select().from(ndas).orderBy(desc(ndas.createdAt)),
          db.select().from(verificationRuns).orderBy(desc(verificationRuns.createdAt)).limit(15),
        ]),
        15000,
        "freelancer queries"
      );
    } catch (err) {
      degraded = err instanceof Error ? err.message : "Live data could not be loaded.";
    }
  }

  const projectMap = new Map(projectRows.map((p) => [p.id, p]));

  const totalEarnedUsd = milestoneRows
    .filter((m) => m.status === "paid")
    .reduce((sum, m) => sum + parseFloat(m.captureNetUsd || m.budgetUsd || "0"), 0);

  const pendingEscrowUsd = milestoneRows
    .filter((m) => ["funded", "submitted", "verifying", "pending_approval"].includes(m.status))
    .reduce((sum, m) => sum + parseFloat(m.captureNetUsd || m.budgetUsd || "0"), 0);

  const upcomingDeliverables = milestoneRows.filter(
    (m) => m.status !== "paid" && m.status !== "cancelled"
  );

  const pendingNdaCount = ndaRows.filter((n) => n.status === "sent").length;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8">
      {degraded && (
        <DbStatusBanner
          title="Live data unavailable — workspace cannot load."
          detail={`${degraded} Nothing is shown because the database could not be reached, not because there is no work assigned.`}
        />
      )}
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/90 px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-emerald-500/20 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-emerald-300">
              Consultant Workspace
            </span>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400">
              ● Availability: Available for Assignments
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-white">
            Freelancer Deliverables, Earnings &amp; Assignments
          </h1>
          <p className="text-xs text-slate-400">
            Submit GitHub PR deliverables for automated Delivery Agent verification and track PayPal milestone payouts.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Link
            href="/demo-inbox"
            className="rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/25"
          >
            ✉ NDA Invitations ({pendingNdaCount})
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Verified Earnings (Paid)</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-400">
            ${totalEarnedUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {demoTables ? "Simulated payouts (demo scenario)" : "Released via PayPal Payouts"}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Pending Payments (In Escrow)</div>
          <div className="mt-1 font-mono text-2xl font-bold text-blue-400">
            ${pendingEscrowUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {demoTables ? "Simulated escrow (demo scenario)" : "Held in verified milestone escrow"}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Upcoming Deliverables</div>
          <div className="mt-1 font-mono text-2xl font-bold text-white">
            {upcomingDeliverables.length}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Active milestone deadlines
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] font-medium text-slate-400">Active Assignments</div>
          <div className="mt-1 font-mono text-2xl font-bold text-purple-400">
            {candidateRows.length}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Across {projectRows.length} project(s)
          </div>
        </div>
      </div>

      {/* Deliverables & Upcoming Deadlines */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-bold text-white">
              Active Deliverables &amp; Upcoming Deadlines
            </h2>
            <p className="text-xs text-slate-400">
              Submit your GitHub Pull Request for any funded or planned milestone to trigger Delivery Agent verification.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2.5">
          {milestoneRows.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">
              No milestones currently assigned in the database.
            </div>
          ) : (
            milestoneRows.map((m) => {
              const proj = projectMap.get(m.projectId);
              return (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-3 text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{m.title}</span>
                      <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase text-slate-300">
                        {m.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="mt-1 text-slate-400">
                      Project: <strong className="text-slate-200">{proj?.title ?? m.projectId}</strong>
                      {m.dueDate && <span className="ml-3">• Due: {m.dueDate}</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-bold text-emerald-400">
                      ${parseFloat(m.budgetUsd || "0").toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </span>
                    {m.status !== "paid" && (
                      <Link
                        href={`/deliver/${m.id}`}
                        className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                      >
                        Submit PR Deliverable →
                      </Link>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Recent PR Verification Runs & Payment Ledger */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5">
          <h3 className="text-sm font-bold text-white">
            Recent Delivery Agent PR Verifications
          </h3>
          <div className="mt-3 space-y-2">
            {verifRows.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-500">
                No PR verification runs recorded yet.
              </div>
            ) : (
              verifRows.slice(0, 6).map((vr) => (
                <div
                  key={vr.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-blue-400">
                      {vr.prOwner}/{vr.prRepo} #{vr.prNumber}
                    </span>
                    <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase text-slate-300">
                      {vr.policyDecision ?? vr.status}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    HEAD SHA: <code>{vr.headSha?.slice(0, 12) ?? "—"}</code>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5">
          <h3 className="text-sm font-bold text-white">
            Consultant Payout History
          </h3>
          <div className="mt-3 space-y-2">
            {paymentRows.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-500">
                No payment records yet.
              </div>
            ) : (
              paymentRows.slice(0, 6).map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs"
                >
                  <div>
                    <div className="font-mono font-semibold text-slate-200">
                      Payment {p.id}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Batch: {p.paypalPayoutBatchId ?? "Awaiting release"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-bold text-emerald-400">
                      ${parseFloat(p.netUsd || p.grossUsd || "0").toFixed(2)} USD
                    </div>
                    <div className="text-[10px] uppercase text-slate-400">
                      {p.status}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
