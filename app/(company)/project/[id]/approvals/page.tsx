// Disable static pre-rendering: reads DB at request time.
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects, milestones, payments, approvals, candidates } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApprovalCard } from "@/components/payments/ApprovalCard";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { requireProjectAccess } from "@/lib/auth/guards";

export default async function ApprovalsPage({
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
          .select()
          .from(projects)
          .where(eq(projects.id, id))
          .limit(1)
      )[0];

  if (!project) notFound();

  // Load funded milestones for this project
  const fundedMilestones = demoTables
    ? demoTables.milestones
        .filter(
          (m) =>
            m.projectId === id &&
            (m.status === "funded" ||
              m.status === "pending_approval" ||
              m.status === "verifying")
        )
        .sort((a, b) => a.position - b.position)
    : await db
        .select()
        .from(milestones)
        .where(
          and(
            eq(milestones.projectId, id),
            inArray(milestones.status, ["funded", "pending_approval", "verifying"])
          )
        )
        .orderBy(milestones.position);

  if (fundedMilestones.length === 0) {
    return (
      <div className="px-6 py-8 max-w-4xl mx-auto w-full space-y-4">
        <h1 className="text-2xl font-bold">Approvals</h1>
        <p className="text-muted-foreground text-sm">
          No milestones awaiting payout approval. Fund a milestone first.
        </p>
      </div>
    );
  }

  // Load payments for funded milestones
  const milestoneIds = fundedMilestones.map((m) => m.id);
  const paymentRows = demoTables
    ? demoTables.payments.filter((p) => milestoneIds.includes(p.milestoneId))
    : await db
        .select()
        .from(payments)
        .where(inArray(payments.milestoneId, milestoneIds));

  // Load pending approvals for these payments
  const paymentIds = paymentRows.map((p) => p.id);
  const approvalRows = demoTables
    ? demoTables.approvals.filter(
        (a) => paymentIds.includes(a.paymentId) && a.decision === "pending"
      )
    : paymentIds.length > 0
      ? await db
          .select()
          .from(approvals)
          .where(
            and(
              inArray(approvals.paymentId, paymentIds),
              eq(approvals.decision, "pending")
            )
          )
      : [];

  // Load candidates for context
  const candidateIds = [...new Set(paymentRows.map((p) => p.candidateId).filter(Boolean))] as string[];
  const candidateRows = demoTables
    ? demoTables.candidates.filter((c) => candidateIds.includes(c.id))
    : candidateIds.length > 0
      ? await db.select().from(candidates).where(inArray(candidates.id, candidateIds))
      : [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Approvals</h1>
          <p className="mt-1 text-xs text-slate-400">
            Human-gated payment approval queue for {project.title}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-950/40 px-2.5 py-1 font-mono text-xs font-medium text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          Sandbox mode
        </span>
      </div>

      <div className="space-y-4">
        {fundedMilestones.map((milestone) => {
          const payment = paymentRows.find((p) => p.milestoneId === milestone.id);
          const approval = payment
            ? approvalRows.find((a) => a.paymentId === payment.id)
            : undefined;
          const candidate = payment?.candidateId
            ? candidateRows.find((c) => c.id === payment.candidateId)
            : undefined;

          // Use real payment ledger if available; fall back to milestone capture fields
          // (milestone-2 was seeded with capture amounts but no payments row)
          const grossUsd  = payment?.grossUsd  ?? milestone.captureGrossUsd;
          const feeUsd    = payment?.feeUsd    ?? milestone.captureFeeUsd;
          const netUsd    = payment?.netUsd    ?? milestone.captureNetUsd;
          const currency  = payment?.currency  ?? "USD";
          // Payout amount: net from capture (what platform holds)
          const payoutAmt = netUsd ?? milestone.budgetUsd;

          const statusLabel =
            milestone.status === "funded"           ? "Held (simulated)" :
            milestone.status === "pending_approval" ? "Awaiting Approval" :
            milestone.status === "verifying"        ? "Payout Processing" :
            milestone.status;
          const badgeVariant =
            milestone.status === "verifying" ? "default" as const : "outline" as const;

          return (
            <Card key={milestone.id} className="border-slate-800 bg-[#0f141e]">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base text-white">{milestone.title}</CardTitle>
                  <Badge variant={badgeVariant}>{statusLabel}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Ledger — always shown when any capture data exists */}
                {(grossUsd || netUsd) && (
                  <div className="rounded-lg border border-slate-800 bg-[#090c12]/80 px-4 py-3 text-xs space-y-1.5">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                      Escrow Ledger Breakdown
                    </p>
                    {grossUsd && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Company paid (gross)</span>
                        <strong className="font-mono tabular-nums text-slate-200">${Number(grossUsd).toFixed(2)} {currency}</strong>
                      </div>
                    )}
                    {feeUsd && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">PayPal fee (orders)</span>
                        <span className="font-mono tabular-nums text-rose-400">−${Number(feeUsd).toFixed(2)}</span>
                      </div>
                    )}
                    {netUsd && (
                      <div className="flex justify-between border-t border-slate-800 pt-1.5 mt-1">
                        <span className="font-medium text-slate-300">Platform holds</span>
                        <strong className="font-mono tabular-nums text-emerald-400">
                          ${Number(netUsd).toFixed(2)} {currency}
                        </strong>
                      </div>
                    )}
                  </div>
                )}

                {/* Approval card — shown when a real payments row exists */}
                {payment ? (
                  <ApprovalCard
                    paymentId={payment.id}
                    milestoneTitle={milestone.title}
                    amountUsd={payoutAmt}
                    currency={currency}
                    justification={payment.justification ?? undefined}
                    candidateName={candidate?.name ?? undefined}
                    candidateEmail={candidate?.email ?? undefined}
                    approvalId={approval?.id ?? undefined}
                    milestoneStatus={milestone.status}
                    paymentStatus={payment.status}
                  />
                ) : (
                  // Milestone was funded via seed/demo — no payments row exists.
                  // Show a note so the user knows to use the milestones page to
                  // fund via the real PayPal flow (which creates the payments row).
                  <p className="text-xs text-muted-foreground rounded-lg border bg-muted/30 px-3 py-2">
                    This milestone was funded via the demo seed (no real PayPal payment row).
                    To trigger a real payout, fund it via{" "}
                    <a href={`/project/${id}/milestones`} className="underline text-foreground">
                      the milestones page
                    </a>{" "}
                    using the PayPal checkout button.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
