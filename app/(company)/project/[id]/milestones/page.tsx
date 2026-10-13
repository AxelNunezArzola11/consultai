// Disable static pre-rendering: reads DB at request time.
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects, milestones, payments, auditLog } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notFound } from "next/navigation";
import { MilestonePaymentPanel } from "@/components/payments/MilestonePaymentPanel";

/**
 * Milestones page — Phase 1.
 * Server component that renders milestone cards.
 * Each "planned" milestone has a client-side PayPal v6 fund button.
 * Funded milestones show the fee breakdown and held amount.
 */
export default async function MilestonesPage({
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

  const milestoneList = await db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, id))
    .orderBy(milestones.position);

  // Load latest audit log entries for the project milestones
  const milestoneIds = milestoneList.map((m) => m.id);
  const auditEntries = milestoneIds.length > 0
    ? await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityType, "milestone"))
        .orderBy(desc(auditLog.createdAt))
        .limit(50)
    : [];

  const statusLabel: Record<string, string> = {
    planned:          "Planned",
    funded:           "Held (simulated)",
    submitted:        "Submitted",
    verifying:        "Verifying",
    pending_approval: "Awaiting Approval",
    paid:             "Paid",
    disputed:         "Disputed",
    cancelled:        "Cancelled",
    failed:           "Failed",
    returned:         "Returned",
  };

  const statusVariant = (status: string): "default" | "secondary" | "outline" | "destructive" => {
    if (status === "paid")                 return "default";
    if (status === "funded")               return "default";
    if (status === "failed" || status === "returned" || status === "disputed") return "destructive";
    return "outline";
  };

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{project.title}</h1>
          <p className="text-muted-foreground text-sm mt-1">Milestones & Payments</p>
        </div>
        {/* Sandbox badge — always visible in Phase 1 */}
        <span className="inline-flex items-center rounded-full border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          Sandbox mode
        </span>
      </div>

      {milestoneList.length === 0 ? (
        <p className="text-muted-foreground">No milestones for this project.</p>
      ) : (
        <div className="space-y-4">
          {milestoneList.map((m) => {
            const relatedAudit = auditEntries.filter((a) => a.entityId === m.id);
            return (
              <Card key={m.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{m.title}</CardTitle>
                    <Badge variant={statusVariant(m.status)}>
                      {statusLabel[m.status] ?? m.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {m.description && (
                    <p className="text-sm text-muted-foreground">{m.description}</p>
                  )}

                  <div className="flex flex-wrap gap-4 text-xs">
                    <span>
                      Budget:{" "}
                      <strong className="text-foreground">
                        ${Number(m.budgetUsd).toLocaleString()} USD
                      </strong>
                    </span>
                    {m.dueDate && (
                      <span>
                        Due: <strong className="text-foreground">{m.dueDate}</strong>
                      </span>
                    )}
                  </div>

                  {/* Fee breakdown — shown when funded */}
                  {(m.captureGrossUsd || m.captureNetUsd) && (
                    <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs space-y-1">
                      <p className="font-medium text-muted-foreground mb-2">PayPal capture breakdown</p>
                      {m.captureGrossUsd && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Company paid (gross)</span>
                          <strong>${Number(m.captureGrossUsd).toFixed(2)}</strong>
                        </div>
                      )}
                      {m.captureFeeUsd && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">PayPal fee (orders)</span>
                          <span className="text-destructive">−${Number(m.captureFeeUsd).toFixed(2)}</span>
                        </div>
                      )}
                      {m.captureNetUsd && (
                        <div className="flex justify-between border-t pt-1 mt-1">
                          <span className="font-medium">Platform holds (simulated)</span>
                          <strong className="text-green-600 dark:text-green-400">
                            ${Number(m.captureNetUsd).toFixed(2)} {m.currency ?? "USD"}
                          </strong>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Payment panel — fund button for planned, status for others */}
                  <MilestonePaymentPanel
                    milestoneId={m.id}
                    milestoneTitle={m.title}
                    budgetUsd={m.budgetUsd}
                    status={m.status}
                    captureId={m.paypalCaptureId ?? null}
                    orderId={m.paypalOrderId ?? null}
                    auditEntries={relatedAudit.map((a) => ({
                      id:        String(a.id),
                      event:     a.event,
                      actor:     a.actor,
                      createdAt: a.createdAt.toISOString(),
                    }))}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
