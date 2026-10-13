// Disable static pre-rendering: this page reads from the DB at request time.
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects, milestones } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notFound } from "next/navigation";

/**
 * Milestones page — server component.
 * Phase 0: displays milestone list with status badges.
 * Phase 1 will add: PayPal JS SDK button, capture flow, MoneyFlow animation.
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

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{project.title}</h1>
        <p className="text-muted-foreground text-sm mt-1">Milestones & Payments</p>
      </div>

      {milestoneList.length === 0 ? (
        <p className="text-muted-foreground">No milestones for this project.</p>
      ) : (
        <div className="space-y-4">
          {milestoneList.map((m) => (
            <Card key={m.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{m.title}</CardTitle>
                  <Badge variant={m.status === "paid" ? "default" : "outline"}>
                    {m.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-1">
                {m.description && <p>{m.description}</p>}
                <div className="flex gap-6 text-xs mt-2">
                  <span>
                    Budget:{" "}
                    <strong className="text-foreground">
                      ${Number(m.budgetUsd).toLocaleString()}
                    </strong>
                  </span>
                  {m.captureNetUsd && (
                    <span>
                      Held:{" "}
                      <strong className="text-foreground">
                        ${Number(m.captureNetUsd).toLocaleString()}
                      </strong>
                    </span>
                  )}
                  {m.dueDate && (
                    <span>
                      Due:{" "}
                      <strong className="text-foreground">{m.dueDate}</strong>
                    </span>
                  )}
                </div>
                {/* Phase 1: PayPal button + MoneyFlow animation goes here */}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
