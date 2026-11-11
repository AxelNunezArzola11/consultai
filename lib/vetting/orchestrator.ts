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
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  fetchGitHubRepo,
  fetchGitHubPrFiles,
  fetchGitHubRepos,
  rankReposForVetting,
} from "./github-fetcher";
import { safeFetch, validateUrl, LinkedInBlockedError, SsrfBlockedError } from "./ssrf-safe-fetch";
import { extractSignals } from "./llm-extraction";
import { computeTrustScore, buildMatrix, buildScoreBreakdown, type Signal } from "./signals";
import type { VettingDiagnostics } from "./diagnostics";

export interface VettingInput {
  candidateId: string;
  projectId: string;
  /** Requirements (general tech skills) sent to the LLM as evaluation criteria */
  requirements: Array<{ id: string; description: string }>;
  /** Whether to use cached signals if content hash unchanged */
  useCache?: boolean;
}

export interface DebugEntry {
  sourceUrl: string;
  signalType: string;
  /** The exact requirements array sent to the LLM */
  requirementsSent: Array<{ id: string; description: string }>;
  /** The exact prompt string sent to the LLM */
  promptSent?: string;
  /** The parsed LLM output object (before signal building) */
  llmOutput?: unknown;
  /** The raw string response from Groq before any JSON parsing */
  rawLlmText?: string;
  /** Error message if the LLM call failed */
  error?: string;
  /** Whether the deterministic fallback was used */
  usedFallback: boolean;
  signalsProduced: number;
  fabricatedDropped: number;
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
  /** Debug payload — requirements sent to LLM, raw LLM output per source */
  debugLog: DebugEntry[];
  /** Persisted per-run diagnostics (also stored on the candidate row) */
  diagnostics: VettingDiagnostics;
}

/**
 * Map with bounded concurrency, preserving input order in the output.
 *
 * Vetting uses a limit of 2: fully serial analysis exceeds the 60s
 * serverless limit, while fully concurrent analysis bursts past Groq's
 * per-minute input-token quota (429s). Two at a time keeps a 5-repo run
 * around 10–20s with a small token burst.
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Self-healing bootstrap for the `vetting_diagnostics` column (migration
 * 0011). Idempotent `ADD COLUMN IF NOT EXISTS`, so concurrent vetting runs
 * are safe. Best-effort: a failure here never breaks the vetting run —
 * diagnostics persistence is skipped instead (see step 8b).
 */
async function ensureVettingDiagnosticsColumn(): Promise<boolean> {
  try {
    await db.execute(
      sql`ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "vetting_diagnostics" jsonb`
    );
    return true;
  } catch {
    return false;
  }
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
  const debugLog: DebugEntry[] = [];

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

  // 4. GitHub profile + repos (with README and config file content)
  // Per-repo analysis runs at bounded concurrency (2): fully serial runs
  // exceed the 60s serverless limit (observed 57s+), while unbounded
  // concurrency bursts past Groq's per-minute token quota (429s).
  // Results merge in rank order afterwards, so signals/debug/errors stay
  // deterministic regardless of completion order.
  const reposAnalyzed: string[] = [];
  if (candidate.githubHandle) {
    try {
      const reposResult = await fetchGitHubRepos(candidate.githubHandle);
      // Warn when the GitHub quota is nearly exhausted — remaining sources
      // in this run may fail and scores may be incomplete until reset.
      const quota = reposResult.rateLimit;
      if (quota && quota.limit > 0 && quota.remaining / quota.limit < 0.1) {
        errors.push(
          `GitHub API quota low (${quota.remaining}/${quota.limit} remaining) — results may be incomplete until reset.`
        );
      }
      // Analyze the most prominent repos (stars → forks → recency), not the
      // most recently touched ones, so substantial work is actually examined.
      const rankedRepos = rankReposForVetting(reposResult.data);
      reposAnalyzed.push(...rankedRepos.map((r) => r.fullName));

      const analyzed = await mapWithConcurrencyLimit(
        rankedRepos,
        2,
        async (repoSummary) => {
          const sourceUrl = repoSummary.htmlUrl;
          const [owner, repoName] = repoSummary.fullName.split("/");
          try {
            // Fetch full repo detail: README + languages + config files
            let repoDetail;
            let detailError: string | null = null;
            try {
              const detailResult = await fetchGitHubRepo(owner, repoName);
              repoDetail = detailResult.data;
            } catch (fetchErr) {
              // If detailed fetch fails, fall back to summary-only metadata
              detailError =
                `GitHub repo detail fetch failed for ${repoSummary.fullName}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
              repoDetail = null;
            }

            // Build rich content for the LLM
            const contentParts: string[] = [
              `Repository: ${repoSummary.fullName}`,
              repoSummary.description ? `Description: ${repoSummary.description}` : "",
              `Language: ${repoSummary.language ?? "unknown"}`,
              `Topics: ${repoSummary.topics.join(", ")}`,
              `Stars: ${repoSummary.stargazersCount}`,
            ];

            if (repoDetail) {
              // Languages breakdown
              const langEntries = Object.entries(repoDetail.languages)
                .sort(([, a], [, b]) => b - a)
                .map(([lang, bytes]) => `${lang}: ${bytes}`)
                .join(", ");
              if (langEntries) contentParts.push(`Languages (bytes): ${langEntries}`);

              // README
              if (repoDetail.readme) {
                contentParts.push("", "--- README ---", repoDetail.readme);
              }

              // Config / dependency files
              for (const [filename, fileContent] of Object.entries(repoDetail.configFiles)) {
                contentParts.push("", `--- ${filename} ---`, fileContent);
              }
            }

            const content = contentParts.filter(Boolean).join("\n");

            const result = await extractSignals({
              candidateId,
              signalType: "github_repo",
              sourceUrl,
              content,
              requirements,
            });

            return { repoSummary, sourceUrl, detailError, result };
          } catch (err) {
            // Never let one repo fail the whole run.
            return {
              repoSummary,
              sourceUrl,
              detailError: null as string | null,
              result: {
                signals: [],
                contentHash: "",
                fabricatedDropped: 0,
                usedFallback: false as boolean,
                error: `GitHub repo ${repoSummary.name}: ${err instanceof Error ? err.message : String(err)}`,
                debugPrompt: undefined as string | undefined,
                debugLlmOutput: undefined as unknown,
                debugRawText: undefined as string | undefined,
              },
            };
          }
        }
      );

      // Merge in rank order (mapWithConcurrencyLimit preserves input order).
      for (const { repoSummary, sourceUrl, detailError, result } of analyzed) {
        if (detailError) errors.push(detailError);
        fabricatedDropped += result.fabricatedDropped;
        if (result.usedFallback) usedFallback = true;
        allSignals.push(...result.signals);

        debugLog.push({
          sourceUrl,
          signalType: "github_repo",
          requirementsSent: requirements,
          promptSent: result.debugPrompt,
          llmOutput: result.debugLlmOutput,
          rawLlmText: result.debugRawText,
          error: result.error,
          usedFallback: result.usedFallback,
          signalsProduced: result.signals.length,
          fabricatedDropped: result.fabricatedDropped,
        });

        if (result.error) {
          errors.push(`GitHub repo ${repoSummary.name}: ${result.error}`);
        }
      }
    } catch (err) {
      errors.push(`GitHub fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4b. GitHub PR signals — parse owner/repo/pull_number from signal source URLs
  //   Source URL format: https://github.com/{owner}/{repo}/pull/{number}
  //   These are stored as github_pr signals in the candidate's provided links.
  if (candidate.githubHandle) {
    const prUrlPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
    // portfolioUrl may be a PR link; also check any future prLinks field
    const prCandidate = candidate.portfolioUrl ?? "";
    const prMatch = prUrlPattern.exec(prCandidate);
    if (prMatch) {
      const [, prOwner, prRepo, prNumStr] = prMatch;
      const prNumber = parseInt(prNumStr, 10);
      try {
        const prFilesResult = await fetchGitHubPrFiles(prOwner, prRepo, prNumber);
        const files = prFilesResult.data;

        const contentParts: string[] = [
          `Pull Request: ${prCandidate}`,
          `Changed files: ${files.length}`,
          `Total additions: ${files.reduce((s, f) => s + f.additions, 0)}`,
          `Total deletions: ${files.reduce((s, f) => s + f.deletions, 0)}`,
          "",
          "--- PR File Diffs ---",
        ];

        for (const f of files) {
          contentParts.push(`File: ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`);
          if (f.patch) contentParts.push(f.patch);
        }

        const content = contentParts.join("\n");

        const result = await extractSignals({
          candidateId,
          signalType: "github_pr",
          sourceUrl: prCandidate,
          content,
          requirements,
        });

        fabricatedDropped += result.fabricatedDropped;
        if (result.usedFallback) usedFallback = true;
        allSignals.push(...result.signals);

        debugLog.push({
          sourceUrl: prCandidate,
          signalType: "github_pr",
          requirementsSent: requirements,
          promptSent: result.debugPrompt,
          llmOutput: result.debugLlmOutput,
          rawLlmText: result.debugRawText,
          error: result.error,
          usedFallback: result.usedFallback,
          signalsProduced: result.signals.length,
          fabricatedDropped: result.fabricatedDropped,
        });

        if (result.error) {
          errors.push(`GitHub PR ${prCandidate}: ${result.error}`);
        }
      } catch (err) {
        errors.push(`GitHub PR fetch failed for ${prCandidate}: ${err instanceof Error ? err.message : String(err)}`);
      }
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

      debugLog.push({
        sourceUrl: candidate.portfolioUrl,
        signalType: "portfolio",
        requirementsSent: requirements,
        promptSent: result.debugPrompt,
        llmOutput: result.debugLlmOutput,
        rawLlmText: result.debugRawText,
        error: result.error,
        usedFallback: result.usedFallback,
        signalsProduced: result.signals.length,
        fabricatedDropped: result.fabricatedDropped,
      });

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

    try {
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
    } catch (dbErr) {
      const detail = dbErr instanceof Error ? dbErr.message : String(dbErr);
      throw new Error(`DB insert failed for signal ${sig.id} (${sig.signalType}): ${detail}`);
    }
  }

  // 8. Update candidate record
  try {
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
  } catch (dbErr) {
    const detail = dbErr instanceof Error ? dbErr.message : String(dbErr);
    throw new Error(`DB update failed for candidate ${candidateId}: ${detail}`);
  }

  // 8b. Persist per-run diagnostics (best-effort, never breaks the run).
  // Explains the score — especially 0 — on the vetting card afterwards.
  const diagnostics: VettingDiagnostics = {
    ranAt: new Date().toISOString(),
    signalCount: allSignals.length,
    usedFallback,
    fabricatedDropped,
    reposAnalyzed,
    errors: errors.slice(-10),
  };
  if (await ensureVettingDiagnosticsColumn()) {
    try {
      await db
        .update(candidates)
        .set({ vettingDiagnostics: diagnostics })
        .where(eq(candidates.id, candidateId));
    } catch {
      // Diagnostics are observability only — the run already succeeded.
    }
  }

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
    debugLog,
    diagnostics,
  };
}
