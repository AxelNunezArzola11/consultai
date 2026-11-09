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
import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { isDemoMode, DEMO_IDS } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { withTimeout } from "@/lib/db/with-timeout";
import { DbStatusBanner } from "@/components/demo/DbStatusBanner";
import { requirePageRole, requireProjectAccess, scopedCompanyId } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function AiOperationsCenterPage({
  searchParams,
}: {
  searchParams?: Promise<{ executionId?: string; projectId?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  // Authenticate + authorize BEFORE querying/rendering (demo bypass: fixtures only).
  const auth = await requirePageRole(["company", "admin"]);
  const scope = scopedCompanyId(auth);
  if (!auth.demoBypass && scope && params.projectId) {
    // Explicit project param: verify ownership before any query (cross-company -> notFound).
    await requireProjectAccess(params.projectId);
  }
  if (!auth.demoBypass && auth.role === "company" && !scope) {
    // Live session-less company holder: no company scope to render, and
    // unscoped reads are not allowed — re-authenticate instead.
    redirect("/login");
  }

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
  // Snapshot scope: verified session company, or global for admin. Demo
  // session-less holders see the fictional TechNova fixtures (demo parity).
  const snapshotRole = auth.role === "admin" ? "admin" : "company";
  const snapshotScope =
    scope ?? (snapshotRole === "admin" ? null : auth.demoBypass ? DEMO_IDS.company : null);
  const [snapshotOutcome, projectRows] = await Promise.all([
    withTimeout(
      getAiOpsDashboardSnapshot({
        projectId: params.projectId,
        scopeCompanyId: snapshotScope,
        role: snapshotRole,
      }),
      15000,
      "ai-ops snapshot"
    )
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
      // Live company sessions see their own projects only.
      : Promise.resolve()
          .then(() => {
            const base = db
              .select({ id: projects.id, title: projects.title })
              .from(projects);
            const scoped = scope ? base.where(eq(projects.companyId, scope)) : base;
            return scoped.orderBy(desc(projects.createdAt)).limit(30);
          })
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
