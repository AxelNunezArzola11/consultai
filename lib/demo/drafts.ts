/**
 * Demo draft resolution for the planner (/project/new?projectId=...).
 *
 * Serverless-safe reads for serverless-unsafe memory: the demo store is
 * per-instance (`lib/demo/store.ts`), but Vercel routes the creation POST
 * and the planner GET to potentially different instances. When the planner
 * lands on an instance that never saw the POST, the lookup misses even
 * though creation returned 201.
 *
 * resolveDemoDraftForPlanning closes that gap WITHOUT weakening any
 * contract:
 * - Existing rows win: a stored row is returned untouched, never
 *   overwritten by URL params.
 * - Rehydration requires the creation params (id + non-blank title) that
 *   POST /api/projects accepted. Bare or invalid IDs still miss, so the
 *   "Draft project not found" screen stays a legitimate not-found state.
 * - The owning company is caller-supplied (the page derives it from the
 *   authenticated session exactly like POST does). It is never read from
 *   the URL, so links cannot spoof ownership — and the page's company
 *   scope check still runs on the result.
 * - Validation mirrors POST /api/projects (id required, max 64 chars;
 *   title trimmed, max 200 chars; brief max 20000 chars).
 */
import { getDemoTables } from "./store";

/**
 * Owning company for demo project writes, derived server-side exactly like
 * POST /api/projects: verified session company first, fictional first demo
 * company fallback. Single source for the planner page and every demo API
 * branch that rehydrates, so rehydrated rows always match the creator scope.
 */
export function demoCompanyForSession(
  sessionCompanyId: string | null | undefined
): string {
  return (
    sessionCompanyId ??
    getDemoTables().companies[0]?.id ??
    "demo-company-technova"
  );
}

export interface DemoDraftParams {
  projectId: string;
  /** Creation title from navigation params; required to rehydrate a miss. */
  title?: string;
  /** Creation brief from navigation params; optional. */
  brief?: string;
  /** Server-derived owning company (session first, demo fallback). */
  companyId: string;
}

export interface DemoDraftRef {
  id: string;
  title: string;
  rawBrief: string | null;
  companyId: string | null;
}

export function resolveDemoDraftForPlanning(
  params: DemoDraftParams
): DemoDraftRef | undefined {
  const projectId = params.projectId.trim();
  if (!projectId || projectId.length > 64) return undefined;

  const tables = getDemoTables();
  const existing = tables.projects.find((p) => p.id === projectId);
  if (existing) {
    return {
      id: existing.id,
      title: existing.title,
      rawBrief: existing.rawBrief,
      companyId: existing.companyId,
    };
  }

  const title = (params.title ?? "").trim().slice(0, 200);
  if (!title) return undefined;
  const brief = params.brief?.trim().slice(0, 20000) || null;

  // Rehydrate the POST-accepted draft into this instance's store. Shape and
  // defaults mirror the POST /api/projects demo branch exactly.
  const now = new Date();
  tables.projects.push({
    id: projectId,
    companyId: params.companyId,
    title,
    rawBrief: brief,
    structuredBrief: null,
    structuredPlan: null,
    sanitizedSummary: null,
    githubRepoUrl: null,
    acceptanceCriteria: null,
    status: "draft",
    autoApproveThresholdUsd: "500.00",
    createdAt: now,
    updatedAt: now,
  });
  return { id: projectId, title, rawBrief: brief, companyId: params.companyId };
}
