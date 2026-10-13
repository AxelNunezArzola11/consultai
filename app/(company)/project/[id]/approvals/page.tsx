// Disable static pre-rendering: reads DB at request time.
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects, milestones, payments, approvals, candidates } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApprovalCard } from "@/components/payments/ApprovalCard";

export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (!project) notFound();

  // Load funded milestones for this project
  const fundedMilestones = await db
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
  const paymentRows = await db
    .select()
    .from(payments)
    .where(inArray(payments.milestoneId, milestoneIds));

  // Load pending approvals for these payments
  const paymentIds = paymentRows.map((p) => p.id);
  const approvalRows = paymentIds.length > 0
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
  const candidateRows = candidateIds.length > 0
    ? await db.select().from(candidates).where(inArray(candidates.id, candidateIds))
    : [];

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Approvals</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Payment approval queue for {project.title}
          </p>
        </div>
        <span className="inline-flex items-center rounded-full border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
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

          return (
            <Card key={milestone.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{milestone.title}</CardTitle>
                  <Badge variant={milestone.status === "verifying" ? "default" : "outline"}>
                    {milestone.status === "funded"           ? "Held (simulated)" :
                     milestone.status === "pending_approval" ? "Awaiting Approval" :
                     milestone.status === "verifying"        ? "Payout Processing" :
                     milestone.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Fee breakdown */}
                {payment && (
                  <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs space-y-1">
                    <p className="font-medium text-muted-foreground mb-1">Ledger</p>
                    {payment.grossUsd && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Company paid (gross)</span>
                        <strong>${Number(payment.grossUsd).toFixed(2)} {payment.currency ?? "USD"}</strong>
                      </div>
                    )}
                    {payment.feeUsd && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">PayPal fee (orders)</span>
                        <span className="text-destructive">−${Number(payment.feeUsd).toFixed(2)}</span>
                      </div>
                    )}
                    {payment.netUsd && (
                      <div className="flex justify-between border-t pt-1 mt-1">
                        <span className="font-medium">Platform holds</span>
                        <strong className="text-green-600 dark:text-green-400">
                          ${Number(payment.netUsd).toFixed(2)} {payment.currency ?? "USD"}
                        </strong>
                      </div>
                    )}
                  </div>
                )}

                {/* Approval card */}
                {payment && (
                  <ApprovalCard
                    paymentId={payment.id}
                    milestoneTitle={milestone.title}
                    amountUsd={payment.netUsd ?? milestone.budgetUsd}
                    currency={payment.currency ?? "USD"}
                    justification={payment.justification ?? undefined}
                    candidateName={candidate?.name ?? undefined}
                    candidateEmail={candidate?.email ?? undefined}
                    approvalId={approval?.id ?? undefined}
                    milestoneStatus={milestone.status}
                    paymentStatus={payment.status}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
