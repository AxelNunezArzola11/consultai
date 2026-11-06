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
import { candidates } from "@/lib/db/schema";
import { eq, sql, and, ilike, or } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const projectId = searchParams.get("projectId");
  const query = searchParams.get("q")?.trim();

  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const q = (query ?? "").toLowerCase();
    const results = getDemoTables()
      .candidates.filter((c) => c.projectId === projectId)
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          (c.githubHandle ?? "").toLowerCase().includes(q)
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
    return NextResponse.json({ results, query: query ?? null, method: "demo_substring" });
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
    // Primary: Postgres full-text search
    // search_vector is populated by trigger on INSERT/UPDATE
    const results = await db
      .select(COLS)
      .from(candidates)
      .where(
        sql`${candidates.projectId} = ${projectId}
          AND search_vector @@ plainto_tsquery('english', ${query})`
      )
      .orderBy(
        // Order by text search rank, then by candidate rank
        sql`ts_rank(search_vector, plainto_tsquery('english', ${query})) DESC`,
        candidates.rank
      );

    return NextResponse.json({ results, query, method: "fts" });
  } catch {
    // Fallback: ILIKE if search_vector not populated or FTS error
    const results = await db
      .select(COLS)
      .from(candidates)
      .where(
        and(
          eq(candidates.projectId, projectId),
          or(
            ilike(candidates.name, `%${query}%`),
            ilike(candidates.email, `%${query}%`),
            ilike(candidates.githubHandle ?? sql`''`, `%${query}%`)
          )
        )
      )
      .orderBy(candidates.rank);

    return NextResponse.json({ results, query, method: "ilike_fallback" });
  }
}
