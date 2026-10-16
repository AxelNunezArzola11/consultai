/**
 * Vetting Agent — Orchestrator
 *
 * Runs the full vetting pipeline for a single candidate:
 * 1. Check candidate has given in-app consent.
 * 2. Fetch GitHub profile + repos (if githubHandle set).
 * 3. Fetch candidate-provided portfolio URL (SSRF-safe).
 * 4. Extract signals from each source using the LLM.
 * 5. Verify quoted excerpts; drop fabricated ones.
 * 6. Compute trust score + build matrix in code (not LLM).
 * 7. Persist signals + update candidate record.
 *
 * Design invariants:
 * - Trust score and matrix are ALWAYS computed by code.
 * - LLM only produces extractedFact + quotedExcerpt per requirement.
 * - If any fetch fails, vetting continues with remaining sources.
 * - If LLM fails for any source, that source produces zero signals (unknown).
 * - Consent is checked before any fetching begins.
 */

import { db } from "@/lib/db";
import { candidates, signals as signalsTable } from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { fetchGitHubRepos } from "./github-fetcher";
import { safeFetch, validateUrl, LinkedInBlockedError, SsrfBlockedError } from "./ssrf-safe-fetch";
import { extractSignals } from "./llm-extraction";
import { computeTrustScore, buildMatrix, buildScoreBreakdown, type Signal } from "./signals";

export interface VettingInput {
  candidateId: string;
  projectId: string;
  /** Requirements from the project's acceptance_criteria */
  requirements: Array<{ id: string; description: string }>;
  /** Whether to use cached signals if content hash unchanged */
  useCache?: boolean;
}

export interface VettingOutput {
  candidateId: string;
  trustScore: number;
  scoreBreakdown: ReturnType<typeof buildScoreBreakdown>;
  matrix: ReturnType<typeof buildMatrix>;
  signals: Signal[];
  errors: string[];
  fabricatedDropped: number;
  usedFallback: boolean;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runVetting(input: VettingInput): Promise<VettingOutput> {
  const { candidateId, projectId, requirements, useCache = true } = input;
  const errors: string[] = [];
  let fabricatedDropped = 0;
  let usedFallback = false;
  const allSignals: Signal[] = [];

  // 1. Load candidate
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, candidateId));

  if (!candidate) {
    throw new Error(`Candidate not found: ${candidateId}`);
  }

  // 2. Check consent
  if (!candidate.vettingConsentAt) {
    throw new Error(`Candidate ${candidateId} has not given vetting consent`);
  }

  // 3. Load existing signals (for cache check)
  const existingSignals: Signal[] = [];
  if (useCache) {
    const rows = await db
      .select()
      .from(signalsTable)
      .where(eq(signalsTable.candidateId, candidateId));

    for (const row of rows) {
      existingSignals.push({
        id: row.id,
        candidateId: row.candidateId,
        requirementId: row.requirementId,
        signalType: row.signalType as Signal["signalType"],
        sourceUrl: row.sourceUrl,
        retrievedAt: row.retrievedAt.toISOString(),
        contentHash: row.contentHash,
        extractedFact: row.extractedFact,
        quotedExcerpt: row.quotedExcerpt,
        confidence: parseFloat(row.confidence),
      });
    }
  }

  // 4. GitHub profile + repos
  if (candidate.githubHandle) {
    try {
      const reposResult = await fetchGitHubRepos(candidate.githubHandle);
      // Each repo is a potential source
      for (const repo of reposResult.data.slice(0, 5)) { // limit to 5 most-recent repos
        const sourceUrl = repo.htmlUrl;
        // Build minimal content from repo metadata
        const content = [
          repo.description ?? "",
          `Language: ${repo.language ?? "unknown"}`,
          `Topics: ${repo.topics.join(", ")}`,
          `Stars: ${repo.stargazersCount}`,
        ].join("\n");

        const result = await extractSignals({
          candidateId,
          signalType: "github_repo",
          sourceUrl,
          content,
          requirements,
        });

        fabricatedDropped += result.fabricatedDropped;
        if (result.usedFallback) usedFallback = true;
        allSignals.push(...result.signals);

        if (result.error) {
          errors.push(`GitHub repo ${repo.name}: ${result.error}`);
        }
      }
    } catch (err) {
      errors.push(`GitHub fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5. Portfolio URL (SSRF-safe)
  if (candidate.portfolioUrl) {
    try {
      // Validate first — LinkedIn = display only, no fetch
      const url = validateUrl(candidate.portfolioUrl);

      const fetchResult = await safeFetch(candidate.portfolioUrl);

      const result = await extractSignals({
        candidateId,
        signalType: "portfolio",
        sourceUrl: candidate.portfolioUrl,
        content: fetchResult.content,
        requirements,
      });

      fabricatedDropped += result.fabricatedDropped;
      if (result.usedFallback) usedFallback = true;
      allSignals.push(...result.signals);

      if (result.error) {
        errors.push(`Portfolio fetch: ${result.error}`);
      }
    } catch (err) {
      if (err instanceof LinkedInBlockedError) {
        errors.push(`LinkedIn URL "${candidate.portfolioUrl}" stored as display-only link — not fetched`);
      } else if (err instanceof SsrfBlockedError) {
        errors.push(`Portfolio URL blocked (SSRF): ${err.message}`);
      } else {
        errors.push(`Portfolio fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 6. Compute score + matrix in CODE (never LLM)
  const trustScore = computeTrustScore(allSignals);
  const scoreBreakdown = buildScoreBreakdown(allSignals);
  const matrix = buildMatrix(requirements, allSignals);

  // Build can_do / cannot_do from matrix
  const canDo = matrix
    .filter((e) => e.state === "can" || e.state === "partial")
    .map((e) => ({
      skill: e.requirementDescription,
      state: e.state,
      evidenceSummary: e.evidenceSummary,
    }));

  const cannotDo = matrix
    .filter((e) => e.state === "no")
    .map((e) => ({
      skill: e.requirementDescription,
      state: e.state,
    }));

  // 7. Persist signals
  for (const sig of allSignals) {
    // Upsert by (candidateId, requirementId, contentHash) — skip if identical signal exists
    const existing = existingSignals.find(
      (e) =>
        e.requirementId === sig.requirementId &&
        e.contentHash === sig.contentHash &&
        e.signalType === sig.signalType
    );
    if (existing) continue; // cache hit — skip insert

    await db.insert(signalsTable).values({
      id: sig.id,
      candidateId: sig.candidateId,
      requirementId: sig.requirementId,
      signalType: sig.signalType,
      sourceUrl: sig.sourceUrl,
      retrievedAt: new Date(sig.retrievedAt),
      contentHash: sig.contentHash,
      extractedFact: sig.extractedFact,
      quotedExcerpt: sig.quotedExcerpt,
      confidence: sig.confidence.toFixed(3),
    }).onConflictDoNothing();
  }

  // 8. Update candidate record
  await db
    .update(candidates)
    .set({
      trustScore: trustScore.toFixed(2),
      canDo,
      cannotDo,
      vettingRanAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(candidates.id, candidateId));

  // 9. Audit log
  await writeAuditLog({
    entityType: "candidate",
    entityId: candidateId,
    event: "VETTING_COMPLETE",
    actor: "agent",
    payload: {
      trustScore,
      signalCount: allSignals.length,
      fabricatedDropped,
      usedFallback,
      errors,
    },
  });

  return {
    candidateId,
    trustScore,
    scoreBreakdown,
    matrix,
    signals: allSignals,
    errors,
    fabricatedDropped,
    usedFallback,
  };
}
