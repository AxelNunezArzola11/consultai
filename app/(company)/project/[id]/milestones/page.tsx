// Disable static pre-rendering: reads DB at request time.
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects, milestones, auditLog } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notFound } from "next/navigation";
import { MoneyFlowPanel } from "@/components/payments/MoneyFlowPanel";
import { MilestonesClientExtensions } from "./MilestonesClientExtensions";

/**
 * Milestones page — Phase 1 Step 6.
 * Server component that renders milestone cards with MoneyFlowPanel.
 * Each milestone card shows the full animated money-flow UI with polling.
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

  // Load latest audit log entries for all project milestones
  const auditEntries = milestoneList.length > 0
    ? await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityType, "milestone"))
        .orderBy(desc(auditLog.createdAt))
        .limit(100)
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
    if (status === "paid" || status === "funded") return "default";
    if (status === "failed" || status === "returned" || status === "disputed") return "destructive";
    if (status === "verifying" || status === "pending_approval") return "secondary";
    return "outline";
  };

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{project.title}</h1>
          <p className="text-muted-foreground text-sm mt-1">Milestones &amp; Payments</p>
        </div>
      </div>

      {/* Client-side extensions: compliance bar, meetings, payment chat, gantt */}
      <MilestonesClientExtensions
        projectId={id}
        milestones={milestoneList.map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          budgetUsd: m.budgetUsd,
        }))}
        ganttMilestones={milestoneList.map((m) => ({
          id:          m.id,
          title:       m.title,
          startDate:   m.startDate   ?? null,
          dueDate:     m.dueDate     ?? null,
          status:      m.status,
          dependsOnId: m.dependsOnId ?? null,
          offsetDays:  m.offsetDays  ?? null,
          version:     m.version,
        }))}
      />

      {milestoneList.length === 0 ? (
        <div className="rounded-xl border bg-muted/30 p-8 text-center">
          <p className="text-muted-foreground text-sm">No milestones for this project.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {milestoneList.map((m) => {
            const relatedAudit = auditEntries
              .filter((a) => a.entityId === m.id)
              .map((a) => ({
                id:        String(a.id),
                event:     a.event,
                actor:     a.actor,
                createdAt: a.createdAt.toISOString(),
              }));

            return (
              <Card key={m.id} className="overflow-hidden">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-3">
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

                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
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

                  {/* Money-flow panel — polling, animated, approval card */}
                  <MoneyFlowPanel
                    milestoneId={m.id}
                    milestoneTitle={m.title}
                    budgetUsd={m.budgetUsd}
                    initialStatus={m.status}
                    initialGrossUsd={m.captureGrossUsd ?? null}
                    initialFeeUsd={m.captureFeeUsd ?? null}
                    initialNetUsd={m.captureNetUsd ?? null}
                    initialCurrency={m.currency ?? null}
                    initialAudit={relatedAudit}
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
