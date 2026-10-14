// Disable static pre-rendering
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects, milestones, verificationRuns, candidates } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActivityStream } from "@/components/delivery/ActivityStream";

export default async function CompanyDeliveryPage({
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

  // Get milestones that are in verifying or later states
  const activeMilestones = await db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, id))
    .orderBy(milestones.position);

  // Get all verification runs for these milestones
  const milestoneIds = activeMilestones.map((m) => m.id);
  const runs =
    milestoneIds.length > 0
      ? await db
          .select()
          .from(verificationRuns)
          .where(
            eq(verificationRuns.milestoneId, milestoneIds[0]) // simplify for now
          )
          .orderBy(desc(verificationRuns.createdAt))
          .limit(10)
      : [];

  // Get selected candidate for recipient email (if any)
  const selectedCandidate = await db
    .select()
    .from(candidates)
    .where(eq(candidates.projectId, id))
    .limit(1);

  const recipientEmail = selectedCandidate[0]?.email ?? undefined;

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Delivery Verification</h1>
          <p className="text-muted-foreground text-sm mt-1">{project.title}</p>
        </div>
        <span className="inline-flex items-center rounded-full border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          Sandbox mode
        </span>
      </div>

      {/* Milestones that can be submitted */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Milestones</h2>
        {activeMilestones.map((m) => (
          <Card key={m.id}>
            <CardContent className="py-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{m.title}</p>
                <p className="text-xs text-muted-foreground">
                  ${Number(m.budgetUsd).toFixed(2)} USD
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{m.status}</Badge>
                {["funded", "submitted", "verifying"].includes(m.status) && (
                  <Link
                    href={`/deliver/${m.id}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    Freelancer submit link →
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Verification runs */}
      {runs.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            No verification runs yet. Share the{" "}
            <strong>Freelancer submit link</strong> above with your consultant
            to start the delivery verification process.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Recent verification runs
          </h2>
          {runs.map((run) => (
            <Card key={run.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">
                    Run {run.id.substring(0, 12)}…
                  </CardTitle>
                  <Badge
                    variant={
                      run.status === "completed"
                        ? "default"
                        : run.status === "failed"
                        ? "destructive"
                        : "outline"
                    }
                  >
                    {run.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  PR:{" "}
                  <a
                    href={run.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {run.prUrl}
                  </a>
                </p>
              </CardHeader>
              <CardContent>
                <ActivityStream
                  runId={run.id}
                  recipientEmail={recipientEmail}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
