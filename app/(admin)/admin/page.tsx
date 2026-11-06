export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import {
  companies,
  projects,
  milestones,
  candidates,
  payments,
  disputes,
  auditLog,
  paypalWebhookDeliveries,
  agentExecutions,
  verificationRuns,
} from "@/lib/db/schema";
import { DemoControlCenter, demoProjectId } from "@/components/demo/DemoControlCenter";
import { withTimeout } from "@/lib/db/with-timeout";
import { DbStatusBanner } from "@/components/demo/DbStatusBanner";
import { ensureAiOpsTables } from "@/lib/ai-ops/orchestrator-engine";
import { desc } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";

/**
 * Administrator Governance Dashboard — Section 9 Differentiated Administrator Experience
 *
 * Connected to real Neon PostgreSQL tables:
 * - Platform activity overview
 * - Users (consultants) and companies
 * - Transactions & PayPal webhook deliveries
 * - Disputes (`disputes` table with PayPal dispute status, reason, amount, evidence packet state)
 * - AI execution monitoring (`agent_executions` + `verification_runs`)
 * - Security and append-only audit information (`audit_log`)
 */
export default async function AdminDashboardPage() {
  await ensureAiOpsTables();

  const demoTables = isDemoMode() ? getDemoTables() : null;
  let degraded: string | null = null;
  let companyRows: Array<typeof companies.$inferSelect> = [];
  let projectRows: Array<typeof projects.$inferSelect> = [];
  let milestoneRows: Array<typeof milestones.$inferSelect> = [];
  let candidateRows: Array<typeof candidates.$inferSelect> = [];
  let paymentRows: Array<typeof payments.$inferSelect> = [];
  let disputeRows: Array<typeof disputes.$inferSelect> = [];
  let auditRows: Array<typeof auditLog.$inferSelect> = [];
  let webhookRows: Array<typeof paypalWebhookDeliveries.$inferSelect> = [];
  let execRows: Array<typeof agentExecutions.$inferSelect> = [];
  let verifRows: Array<typeof verificationRuns.$inferSelect> = [];

  if (demoTables) {
    companyRows = [...demoTables.companies].sort((a, b) => +b.createdAt - +a.createdAt);
    projectRows = [...demoTables.projects].sort((a, b) => +b.createdAt - +a.createdAt);
    milestoneRows = [...demoTables.milestones].sort((a, b) => a.position - b.position);
    candidateRows = [...demoTables.candidates].sort((a, b) => +b.createdAt - +a.createdAt);
    paymentRows = [...demoTables.payments].sort((a, b) => +b.createdAt - +a.createdAt);
    disputeRows = [...demoTables.disputes].sort((a, b) => +b.createdAt - +a.createdAt);
    auditRows = [...demoTables.auditLog].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 40);
    webhookRows = [...demoTables.paypalWebhookDeliveries]
      .sort((a, b) => +b.receivedAt - +a.receivedAt)
      .slice(0, 20);
    execRows = [...demoTables.agentExecutions].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 25);
    verifRows = [...demoTables.verificationRuns].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 25);
  } else {
    try {
      [
        companyRows,
        projectRows,
        milestoneRows,
        candidateRows,
        paymentRows,
        disputeRows,
        auditRows,
        webhookRows,
        execRows,
        verifRows,
      ] = await withTimeout(
        Promise.all([
          db.select().from(companies).orderBy(desc(companies.createdAt)),
          db.select().from(projects).orderBy(desc(projects.createdAt)),
          db.select().from(milestones).orderBy(milestones.position),
          db.select().from(candidates).orderBy(desc(candidates.createdAt)),
          db.select().from(payments).orderBy(desc(payments.createdAt)),
          db.select().from(disputes).orderBy(desc(disputes.createdAt)),
          db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(40),
          db.select().from(paypalWebhookDeliveries).orderBy(desc(paypalWebhookDeliveries.receivedAt)).limit(20),
          db.select().from(agentExecutions).orderBy(desc(agentExecutions.createdAt)).limit(25),
          db.select().from(verificationRuns).orderBy(desc(verificationRuns.createdAt)).limit(25),
        ]),
        15000,
        "admin queries"
      );
    } catch (err) {
      degraded = err instanceof Error ? err.message : "Live data could not be loaded.";
    }
  }

  const totalVolumeUsd = paymentRows.reduce(
    (sum, p) => sum + parseFloat(p.grossUsd || p.netUsd || "0"),
    0
  );

  const controlProjectId = demoTables
    ? demoProjectId()
    : (projectRows[0]?.id ?? "");
  const milestoneProjectById = new Map(milestoneRows.map((m) => [m.id, m.projectId]));
  const firstDispute = disputeRows[0];
  const disputeProjectId = firstDispute
    ? (milestoneProjectById.get(firstDispute.milestoneId) ?? controlProjectId)
    : null;
  const deliverMilestone = milestoneRows.find((m) =>
    ["verifying", "funded", "planned"].includes(m.status)
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      {degraded && (
        <DbStatusBanner
          title="Live data unavailable — oversight grids are empty."
          detail={`${degraded} The grids below show nothing because the database could not be reached, not because the platform is idle.`}
        />
      )}
      <DemoControlCenter
        projectId={controlProjectId}
        disputePath={
          firstDispute && disputeProjectId
            ? `/project/${disputeProjectId}/disputes/${firstDispute.id}`
            : null
        }
        deliverPath={deliverMilestone ? `/deliver/${deliverMilestone.id}` : null}
      />
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/90 px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-purple-500/20 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-purple-300">
              Platform Governance &amp; Security Audit
            </span>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400">
              Append-Only Audit Trigger Active
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-white">
            Administrator Control &amp; Compliance Center
          </h1>
          <p className="text-xs text-slate-400">
            Real-time oversight of companies, consultants, PayPal transactions, disputes, AI agent executions, and immutable audit logs.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/ai-ops"
            className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
          >
            ✦ AI Operations Center
          </Link>
          <Link
            href="/operations"
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
          >
            ⊞ All 7 Operational Grids
          </Link>
        </div>
      </div>

      {/* 6 Admin KPI Cards */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-6">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] text-slate-400">Registered Companies</div>
          <div className="mt-1 font-mono text-2xl font-bold text-white">
            {companyRows.length}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {projectRows.length} total projects
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] text-slate-400">Vetted Consultants</div>
          <div className="mt-1 font-mono text-2xl font-bold text-blue-400">
            {candidateRows.length}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Active talent pool
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] text-slate-400">Transaction Volume</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-400">
            ${totalVolumeUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {paymentRows.length} payment ledger rows
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] text-slate-400">PayPal Disputes</div>
          <div className="mt-1 font-mono text-2xl font-bold text-rose-400">
            {disputeRows.length}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {webhookRows.length} webhook deliveries
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] text-slate-400">AI Executions</div>
          <div className="mt-1 font-mono text-2xl font-bold text-purple-400">
            {execRows.length + verifRows.length}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Supervisor + Delivery runs
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
          <div className="text-[11px] text-slate-400">Audit Log Events</div>
          <div className="mt-1 font-mono text-2xl font-bold text-amber-400">
            {auditRows.length}+
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Immutable DB records
          </div>
        </div>
      </div>

      {/* Disputes & Transactions Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Disputes */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-sm font-bold text-white">
                Disputes &amp; Chargeback Governance
              </h2>
              <p className="text-[11px] text-slate-400">
                Connected to `disputes` table and PayPal Disputes Webhook state.
              </p>
            </div>
            <span className="font-mono text-xs text-rose-400">
              {disputeRows.length} records
            </span>
          </div>

          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
            {disputeRows.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                Zero active disputes in database. All milestone transactions are in good standing.
              </div>
            ) : (
              disputeRows.map((d) => (
                <div
                  key={d.id}
                  className="rounded-xl border border-rose-500/30 bg-slate-950/80 p-3 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-rose-300">
                      {d.paypalDisputeId ?? d.id}
                    </span>
                    <span className="rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-300">
                      {d.status} ({d.evidenceStatus})
                    </span>
                  </div>
                  <div className="mt-1 text-slate-300">
                    Reason: {d.disputeReason ?? "Unspecified"} • Amount: $
                    {d.disputeAmountUsd ?? "0.00"} {d.disputeAmountCurrency ?? "USD"}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* AI Execution Monitoring */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-sm font-bold text-white">
                AI Execution &amp; Human Gate Monitoring
              </h2>
              <p className="text-[11px] text-slate-400">
                Live multi-agent traces and approval gate compliance.
              </p>
            </div>
            <Link href="/ai-ops" className="text-xs text-blue-400 hover:underline">
              Full Console →
            </Link>
          </div>

          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
            {execRows.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                No Supervisor executions recorded yet.
              </div>
            ) : (
              execRows.slice(0, 8).map((ex) => (
                <div
                  key={ex.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-blue-400">
                      {ex.id}
                    </span>
                    <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase text-slate-300">
                      {ex.status} • Gate: {ex.approvalStatus}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-1 text-slate-200">
                    {ex.userRequest}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-slate-500">
                    Intent: {ex.intent} • {ex.durationMs}ms • {ex.totalTokens} tokens
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Append-Only Security & Audit Log Viewer */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-sm font-bold text-white">
              Append-Only Security &amp; Operational Audit Log (`audit_log`)
            </h2>
            <p className="text-[11px] text-slate-400">
              Enforced by PostgreSQL trigger (`0001_audit_log_append_only_trigger.sql`) — rows can never be updated or deleted.
            </p>
          </div>
          <span className="font-mono text-xs text-slate-400">
            Showing latest {auditRows.length} entries
          </span>
        </div>

        <div className="mt-3 max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 text-[10px] uppercase text-slate-400">
              <tr>
                <th className="py-2 pr-3">ID</th>
                <th className="py-2 pr-3">Event</th>
                <th className="py-2 pr-3">Entity</th>
                <th className="py-2 pr-3">Actor</th>
                <th className="py-2 pr-3">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
              {auditRows.map((row) => (
                <tr key={String(row.id)} className="hover:bg-slate-950/60">
                  <td className="py-2 pr-3 text-slate-400">#{String(row.id)}</td>
                  <td className="py-2 pr-3 font-semibold text-emerald-400">
                    {row.event}
                  </td>
                  <td className="py-2 pr-3 text-slate-300">
                    {row.entityType}:{row.entityId}
                  </td>
                  <td className="py-2 pr-3 text-blue-300">{row.actor}</td>
                  <td className="py-2 pr-3 text-slate-500">
                    {row.createdAt.toISOString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
