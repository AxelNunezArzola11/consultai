/**
 * GET /api/candidates/search?projectId=xxx&q=xxx
 *
 * Full-text search over candidates using Postgres tsvector.
 * Falls back to ILIKE if search_vector column is not yet populated.
 *
 * Elastic: Not used (trial period unconfirmed — Spike 7 PARTIAL PASS).
 * Postgres FTS: BM25-equivalent, validated with plainto_tsquery.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { candidates, projects } from "@/lib/db/schema";
import { eq, sql, and, ilike, or } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";
import { normalizeCandidateSearchQuery } from "@/lib/vetting/github-handle";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";

export async function GET(request: NextRequest) {
  const cookieHeader = request.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(request);
  const { ok, retryAfterSec } = checkRateLimit("candidate-search", ip, 60, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  const { searchParams } = request.nextUrl;
  const projectId = searchParams.get("projectId");
  const rawQuery = searchParams.get("q")?.trim();
  const query = normalizeCandidateSearchQuery(rawQuery);

  if (!projectId || projectId.length > 100) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  if (rawQuery && rawQuery.length > 200) {
    return NextResponse.json({ error: "query too long" }, { status: 400 });
  }

  if (isDemoMode()) {
    if (session?.role === "company" && session.companyId) {
      const { getDemoTables: getTables } = await import("@/lib/demo/store");
      const demoProject = getTables().projects.find((p) => p.id === projectId);
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    const { getDemoTables } = await import("@/lib/demo/store");
    const q = query.toLowerCase();
    const results = getDemoTables()
      .candidates.filter((c) => c.projectId === projectId)
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          (c.githubHandle ?? "").toLowerCase().includes(q) ||
          (c.vettingSummary ?? "").toLowerCase().includes(q)
      )
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
      .map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        githubHandle: c.githubHandle,
        trustScore: c.trustScore,
        status: c.status,
        rank: c.rank,
        vettingConsentAt: c.vettingConsentAt,
        vettingRanAt: c.vettingRanAt,
        canDo: c.canDo,
      }));
    return NextResponse.json({ results, query: query || null, method: "demo_substring" });
  }

  if (session?.role === "company" && session.companyId) {
    const [project] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project || project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  // Shared column selection (includes vetting fields for compliance view)
  const COLS = {
    id: candidates.id,
    name: candidates.name,
    email: candidates.email,
    githubHandle: candidates.githubHandle,
    trustScore: candidates.trustScore,
    status: candidates.status,
    rank: candidates.rank,
    vettingConsentAt: candidates.vettingConsentAt,
    vettingRanAt: candidates.vettingRanAt,
    canDo: candidates.canDo,
  };

  if (!query) {
    // Return all candidates if no query
    const results = await db
      .select(COLS)
      .from(candidates)
      .where(eq(candidates.projectId, projectId))
      .orderBy(candidates.rank);

    return NextResponse.json({ results, query: null });
  }

  try {
    // Primary: Postgres full-text search OR case-insensitive handle/name/email/summary match
    // so searching `@AxelNunezArzola11`, `AxelNunezArzola11`, or `https://github.com/AxelNunezArzola11`
    // always finds the candidate even if search_vector is unindexed or doesn't tokenize camelCase.
    const results = await db
      .select(COLS)
      .from(candidates)
      .where(
        sql`${candidates.projectId} = ${projectId}
          AND (
            search_vector @@ plainto_tsquery('english', ${query})
            OR ${candidates.name} ILIKE ${`%${query}%`}
            OR ${candidates.email} ILIKE ${`%${query}%`}
            OR COALESCE(${candidates.githubHandle}, '') ILIKE ${`%${query}%`}
            OR COALESCE(${candidates.vettingSummary}, '') ILIKE ${`%${query}%`}
          )`
      )
      .orderBy(candidates.rank);

    return NextResponse.json({ results, query, method: "fts_plus_ilike" });
  } catch {
    // Fallback: ILIKE if search_vector column is not yet populated
    const results = await db
      .select(COLS)
      .from(candidates)
      .where(
        and(
          eq(candidates.projectId, projectId),
          or(
            ilike(candidates.name, `%${query}%`),
            ilike(candidates.email, `%${query}%`),
            ilike(candidates.githubHandle ?? sql`''`, `%${query}%`),
            ilike(candidates.vettingSummary ?? sql`''`, `%${query}%`)
          )
        )
      )
      .orderBy(candidates.rank);

    return NextResponse.json({ results, query, method: "ilike_fallback" });
  }
}
