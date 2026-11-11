/**
 * Tests — vetting orchestrator wiring (concurrent repo analysis, merge
 * order, diagnostics persistence).
 *
 * All I/O is mocked: database (drizzle chains), GitHub API, and LLM
 * extraction. No network, no live database.
 *
 * Invariants tested:
 * 1. Repos are analyzed concurrently and merged in prominence rank order
 *    (deterministic signals/debug/errors regardless of completion order).
 * 2. Trust score + matrix come from the merged signals (code-computed).
 * 3. Diagnostics (repos analyzed, errors, fallback state) are persisted on
 *    the candidate row via a self-healing column bootstrap.
 * 4. One failing repo never fails the whole run.
 * 5. Missing candidate / missing consent throw before any fetching.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("./github-fetcher", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./github-fetcher")>();
  return {
    ...orig,
    fetchGitHubRepos: vi.fn(),
    fetchGitHubRepo: vi.fn(),
    fetchGitHubPrFiles: vi.fn(),
  };
});
vi.mock("./llm-extraction", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./llm-extraction")>();
  return { ...orig, extractSignals: vi.fn() };
});

import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/db/audit";
import {
  fetchGitHubRepo,
  fetchGitHubRepos,
  rankReposForVetting,
} from "./github-fetcher";
import { extractSignals } from "./llm-extraction";
import { mapWithConcurrencyLimit, runVetting } from "./orchestrator";
import type { Signal } from "./signals";

const dbMock = db as unknown as Record<string, ReturnType<typeof vi.fn>>;
const writeAuditLogMock = writeAuditLog as unknown as ReturnType<typeof vi.fn>;
const fetchGitHubReposMock = fetchGitHubRepos as unknown as ReturnType<
  typeof vi.fn
>;
const fetchGitHubRepoMock = fetchGitHubRepo as unknown as ReturnType<
  typeof vi.fn
>;
const extractSignalsMock = extractSignals as unknown as ReturnType<typeof vi.fn>;

function repoSummary(name: string, stars: number, forks = 0) {
  return {
    name,
    fullName: `someone/${name}`,
    description: `${name} repo`,
    language: "TypeScript",
    stargazersCount: stars,
    forksCount: forks,
    topics: ["demo"],
    isArchived: false,
    isFork: false,
    createdAt: "2023-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    pushedAt: "2024-06-01T00:00:00Z",
    htmlUrl: `https://github.com/someone/${name}`,
    defaultBranch: "main",
  };
}

function repoDetail(name: string) {
  return {
    summary: repoSummary(name, 1),
    readme: `# ${name}\nEvidence text for ${name}.`,
    languages: { TypeScript: 100 },
    configFiles: {},
  };
}

function signalFor(sourceUrl: string, confidence: number): Signal {
  return {
    id: `sig-${sourceUrl}`,
    candidateId: "cand-1",
    requirementId: "skill-1",
    signalType: "github_repo",
    sourceUrl,
    retrievedAt: "2026-01-01T00:00:00Z",
    contentHash: "hash",
    extractedFact: "fact",
    quotedExcerpt: "excerpt",
    confidence,
  };
}

const CANDIDATE = {
  id: "cand-1",
  githubHandle: "someone",
  portfolioUrl: null,
  vettingConsentAt: new Date("2026-01-01T00:00:00Z"),
};

function mockDb(candidate: unknown, existingSignals: unknown[] = []) {
  const updatePayloads: unknown[] = [];
  const insertedSignals: unknown[] = [];
  dbMock.execute = vi.fn().mockResolvedValue([]);
  dbMock.select = vi
    .fn()
    .mockReturnValueOnce({
      from: () => ({ where: async () => (candidate ? [candidate] : []) }),
    })
    .mockReturnValueOnce({
      from: () => ({ where: async () => existingSignals }),
    });
  dbMock.insert = vi.fn().mockReturnValue({
    values: (v: unknown) => {
      insertedSignals.push(v);
      return { onConflictDoNothing: async () => undefined };
    },
  });
  dbMock.update = vi.fn().mockReturnValue({
    set: (v: unknown) => {
      updatePayloads.push(v);
      return { where: async () => [] };
    },
  });
  return { updatePayloads, insertedSignals };
}

const REQUIREMENTS = [{ id: "skill-1", description: "TypeScript dashboards" }];

describe("runVetting", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("analyzes at bounded concurrency and merges in prominence rank order", async () => {
    mockDb(CANDIDATE);
    const repos = [
      repoSummary("top", 5000),
      repoSummary("mid", 100),
      repoSummary("low-a", 5),
      repoSummary("low-b", 4),
      repoSummary("low-c", 3),
      repoSummary("extra", 2),
    ];
    fetchGitHubReposMock.mockResolvedValue({
      data: repos,
      rateLimit: { limit: 5000, remaining: 4999, reset: 1 },
      etag: null,
    });

    // Reverse completion order: the top-ranked repo finishes LAST, and
    // track overlap to prove the analyses actually run concurrently.
    let inFlight = 0;
    let maxInFlight = 0;
    fetchGitHubRepoMock.mockImplementation(
      async (_owner: string, repo: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const delay = repo === "top" ? 60 : 5;
        await new Promise((r) => setTimeout(r, delay));
        inFlight -= 1;
        return { data: repoDetail(repo), rateLimit: null, etag: null };
      }
    );
    extractSignalsMock.mockImplementation(
      async ({ sourceUrl }: { sourceUrl: string }) => ({
        signals: sourceUrl.endsWith("/top") ? [signalFor(sourceUrl, 0.85)] : [],
        contentHash: "h",
        fabricatedDropped: 0,
        usedFallback: false,
      })
    );

    const out = await runVetting({
      candidateId: "cand-1",
      projectId: "proj-1",
      requirements: REQUIREMENTS,
    });

    // Bounded concurrency: overlaps work but never bursts past the limit.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    // Only the top 5 by prominence are analyzed (rank, not recency).
    expect(out.diagnostics.reposAnalyzed).toEqual(
      rankReposForVetting(repos).map((r) => r.fullName)
    );
    expect(out.diagnostics.reposAnalyzed).toHaveLength(5);
    // Merge order follows rank even though "top" finished last.
    expect(out.debugLog.map((d) => d.sourceUrl)).toEqual(
      rankReposForVetting(repos).map((r) => r.htmlUrl)
    );
    // Score comes from the merged signals in code.
    expect(out.trustScore).toBe(0.85);
    expect(out.signals).toHaveLength(1);
    expect(out.errors).toEqual([]);
    expect(writeAuditLogMock).toHaveBeenCalled();
  });

  it("persists score + diagnostics on the candidate row (self-healing column)", async () => {
    const { updatePayloads } = mockDb(CANDIDATE);
    fetchGitHubReposMock.mockResolvedValue({
      data: [repoSummary("only", 10)],
      rateLimit: null,
      etag: null,
    });
    fetchGitHubRepoMock.mockResolvedValue({
      data: repoDetail("only"),
      rateLimit: null,
      etag: null,
    });
    extractSignalsMock.mockResolvedValue({
      signals: [],
      contentHash: "h",
      fabricatedDropped: 0,
      usedFallback: false,
    });

    const out = await runVetting({
      candidateId: "cand-1",
      projectId: "proj-1",
      requirements: REQUIREMENTS,
    });

    // Column bootstrap ran before the diagnostics write.
    expect(dbMock.execute).toHaveBeenCalled();
    // Main update carries the score; second update carries diagnostics.
    expect(updatePayloads).toHaveLength(2);
    const main = updatePayloads[0] as Record<string, unknown>;
    const diag = updatePayloads[1] as Record<string, unknown>;
    expect(main.trustScore).toBe("0.00");
    expect(diag.vettingDiagnostics).toMatchObject({
      signalCount: 0,
      usedFallback: false,
      reposAnalyzed: ["someone/only"],
    });
    expect(out.diagnostics).toMatchObject({ signalCount: 0 });
  });

  it("records a low-quota warning without failing the run", async () => {
    mockDb(CANDIDATE);
    fetchGitHubReposMock.mockResolvedValue({
      data: [repoSummary("only", 10)],
      rateLimit: { limit: 60, remaining: 3, reset: 1 },
      etag: null,
    });
    fetchGitHubRepoMock.mockResolvedValue({
      data: repoDetail("only"),
      rateLimit: null,
      etag: null,
    });
    extractSignalsMock.mockResolvedValue({
      signals: [signalFor("https://github.com/someone/only", 0.55)],
      contentHash: "h",
      fabricatedDropped: 0,
      usedFallback: false,
    });

    const out = await runVetting({
      candidateId: "cand-1",
      projectId: "proj-1",
      requirements: REQUIREMENTS,
    });

    expect(out.trustScore).toBe(0.55);
    expect(out.errors.join(" ")).toContain("quota low");
    expect(out.diagnostics.errors.join(" ")).toContain("quota low");
  });

  it("one failing repo degrades to summary-only and never fails the run", async () => {
    mockDb(CANDIDATE);
    fetchGitHubReposMock.mockResolvedValue({
      data: [repoSummary("good", 50), repoSummary("bad", 40)],
      rateLimit: null,
      etag: null,
    });
    fetchGitHubRepoMock.mockImplementation(
      async (_owner: string, repo: string) => {
        if (repo === "bad") throw new Error("boom");
        return { data: repoDetail(repo), rateLimit: null, etag: null };
      }
    );
    extractSignalsMock.mockResolvedValue({
      signals: [],
      contentHash: "h",
      fabricatedDropped: 0,
      usedFallback: false,
    });

    const out = await runVetting({
      candidateId: "cand-1",
      projectId: "proj-1",
      requirements: REQUIREMENTS,
    });

    // Extraction still ran for both repos (summary-only fallback for "bad").
    expect(extractSignalsMock).toHaveBeenCalledTimes(2);
    expect(out.errors.join(" ")).toContain("someone/bad");
    expect(out.diagnostics.reposAnalyzed).toEqual([
      "someone/good",
      "someone/bad",
    ]);
  });

  it("throws for a missing candidate before any fetching", async () => {
    mockDb(null);
    await expect(
      runVetting({
        candidateId: "nope",
        projectId: "proj-1",
        requirements: REQUIREMENTS,
      })
    ).rejects.toThrow("Candidate not found");
    expect(fetchGitHubReposMock).not.toHaveBeenCalled();
  });

  it("throws when consent was not given before any fetching", async () => {
    mockDb({ ...CANDIDATE, vettingConsentAt: null });
    await expect(
      runVetting({
        candidateId: "cand-1",
        projectId: "proj-1",
        requirements: REQUIREMENTS,
      })
    ).rejects.toThrow("vetting consent");
    expect(fetchGitHubReposMock).not.toHaveBeenCalled();
  });
});

describe("mapWithConcurrencyLimit", () => {
  it("preserves input order with reverse completion order", async () => {
    const out = await mapWithConcurrencyLimit(
      ["a", "b", "c", "d"],
      4,
      async (item, index) => {
        await new Promise((r) => setTimeout(r, (4 - index) * 10));
        return item.toUpperCase();
      }
    );
    expect(out).toEqual(["A", "B", "C", "D"]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return n;
    });
    expect(maxInFlight).toBe(2);
  });

  it("limit 1 runs strictly serially", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapWithConcurrencyLimit([1, 2, 3], 1, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6]);
    expect(maxInFlight).toBe(1);
  });

  it("handles empty input and oversized limits", async () => {
    expect(await mapWithConcurrencyLimit([], 2, async (x) => x)).toEqual([]);
    expect(await mapWithConcurrencyLimit([7], 10, async (x) => x + 1)).toEqual([
      8,
    ]);
  });
});
