/**
 * AI Operations Center — Server Component (route: /ai-ops)
 *
 * Fetches initial real database snapshot of agent availability, active workflows,
 * execution history, financial proposals, and scheduling proposals.
 */

import AiOperationsCenterClient from "@/components/ai-ops/AiOperationsCenterClient";
import { getAiOpsDashboardSnapshot } from "@/lib/ai-ops/orchestrator-engine";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { withTimeout } from "@/lib/db/with-timeout";
import { DbStatusBanner } from "@/components/demo/DbStatusBanner";

export const dynamic = "force-dynamic";

export default async function AiOperationsCenterPage({
  searchParams,
}: {
  searchParams?: Promise<{ executionId?: string; projectId?: string }>;
}) {
  const params = searchParams ? await searchParams : {};

  const demoTables = isDemoMode() ? getDemoTables() : null;
  const emptySnapshot = {
    agents: [],
    executions: [],
    scheduling_proposals: [],
    payment_proposals: [],
    pending_payment_approvals: [],
    verification_runs: [],
    recent_audits: [],
  };
  const [snapshotOutcome, projectRows] = await Promise.all([
    withTimeout(getAiOpsDashboardSnapshot(params.projectId), 15000, "ai-ops snapshot")
      .then((snapshot) => ({ snapshot, degraded: null as string | null }))
      .catch((err: unknown) => ({
        snapshot: emptySnapshot,
        degraded: err instanceof Error ? err.message : "AI Ops data could not be loaded.",
      })),
    demoTables
      ? Promise.resolve(
          [...demoTables.projects]
            .sort((a, b) => +b.createdAt - +a.createdAt)
            .slice(0, 30)
            .map((p) => ({ id: p.id, title: p.title }))
        )
      // Deferred into .then so a synchronous client-construction throw
      // (e.g. missing DATABASE_URL) becomes a rejection, not a page crash.
      : Promise.resolve()
          .then(() =>
            db
              .select({ id: projects.id, title: projects.title })
              .from(projects)
              .orderBy(desc(projects.createdAt))
              .limit(30)
          )
          .catch(() => []),
  ]);

  const { snapshot, degraded: snapshotDegraded } = snapshotOutcome;
  return (
    <>
      {snapshotDegraded && (
        <div className="mx-auto w-full max-w-7xl px-6 pt-6">
          <DbStatusBanner
            title="Live AI Ops data unavailable."
            detail={`${snapshotDegraded} Empty panels below reflect a connection failure, not an idle system.`}
          />
        </div>
      )}
      <AiOperationsCenterClient
        initialSnapshot={snapshot}
        initialSelectedExecutionId={params.executionId}
        projectsList={projectRows}
      />
    </>
  );
}
