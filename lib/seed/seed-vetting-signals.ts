/**
 * Phase 5 seed — Vetting signals for demo candidates
 *
 * Run with: npx tsx lib/seed/seed-vetting-signals.ts
 *
 * Seeds:
 * - vetting consent for candidate-1, candidate-2, candidate-3
 * - preloaded signals for candidate-1 (full set, trust score ~0.78)
 * - preloaded signals for candidate-2 (partial set, trust score ~0.55)
 * - preloaded signals for candidate-3 (sparse set, trust score ~0.35)
 * - One REAL live GitHub lookup for candidate-1 (vertechi — real public account)
 *   NOTE: this will fail silently if GitHub is unreachable or rate-limited
 *
 * All idempotent — safe to re-run.
 */

import "dotenv/config";
import { db } from "@/lib/db";
import { candidates, signals as signalsTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { fetchGitHubRepos } from "@/lib/vetting/github-fetcher";
import { computeTrustScore, buildMatrix, type Signal } from "@/lib/vetting/signals";

const REQUIREMENTS = [
  { id: "ac-1", description: "Dashboard loads in under 2 seconds on a standard broadband connection" },
  { id: "ac-2", description: "Natural language query returns results within 5 seconds for datasets under 1M rows" },
  { id: "ac-3", description: "PayPal transaction data syncs within 60 seconds of a webhook event" },
];

// ---------------------------------------------------------------------------
// Preloaded signals for demo candidates (no LLM needed — deterministic seed)
// ---------------------------------------------------------------------------

const DEMO_SIGNALS: Signal[] = [
  // Candidate 1 — strong evidence
  {
    id: "sig-c1-1",
    candidateId: "candidate-1",
    requirementId: "ac-1",
    signalType: "github_repo",
    sourceUrl: "https://github.com/alexrivera-dev/next-dashboard",
    retrievedAt: "2024-11-01T10:00:00Z",
    contentHash: "abc001",
    extractedFact: "Repository implements Next.js App Router with server-side rendering for fast initial loads. README benchmarks show < 1.8s LCP on broadband.",
    quotedExcerpt: "LCP under 1.8s on broadband",
    confidence: 0.85,
  },
  {
    id: "sig-c1-2",
    candidateId: "candidate-1",
    requirementId: "ac-1",
    signalType: "portfolio",
    sourceUrl: "https://alexrivera.dev",
    retrievedAt: "2024-11-01T10:01:00Z",
    contentHash: "abc002",
    extractedFact: "Portfolio case study describes performance optimization work for a B2B dashboard achieving sub-2s load times.",
    quotedExcerpt: "sub-2s load times achieved through SSR",
    confidence: 0.78,
  },
  {
    id: "sig-c1-3",
    candidateId: "candidate-1",
    requirementId: "ac-2",
    signalType: "github_repo",
    sourceUrl: "https://github.com/alexrivera-dev/realtime-charts",
    retrievedAt: "2024-11-01T10:02:00Z",
    contentHash: "abc003",
    extractedFact: "Repository demonstrates real-time data streaming with SSE and integrates a vector search backend for NL queries.",
    quotedExcerpt: "natural language query via vector search",
    confidence: 0.72,
  },
  {
    id: "sig-c1-4",
    candidateId: "candidate-1",
    requirementId: "ac-3",
    signalType: "github_pr",
    sourceUrl: "https://github.com/some-org/paypal-nextjs/pull/42",
    retrievedAt: "2024-11-01T10:03:00Z",
    contentHash: "abc004",
    extractedFact: "Merged PR adds PayPal webhook handler with HMAC signature verification and near-real-time sync logic.",
    quotedExcerpt: "webhook handler with signature verification and sync within 30 seconds",
    confidence: 0.88,
  },

  // Candidate 2 — partial evidence
  {
    id: "sig-c2-1",
    candidateId: "candidate-2",
    requirementId: "ac-1",
    signalType: "github_repo",
    sourceUrl: "https://github.com/jordankim-eng/react-apps",
    retrievedAt: "2024-11-01T11:00:00Z",
    contentHash: "abc005",
    extractedFact: "Repository contains React apps with Vite build tooling. No specific performance benchmarks for load time mentioned.",
    quotedExcerpt: "fast development builds with Vite",
    confidence: 0.45,
  },
  {
    id: "sig-c2-2",
    candidateId: "candidate-2",
    requirementId: "ac-2",
    signalType: "portfolio",
    sourceUrl: "https://jordankim.io/portfolio",
    retrievedAt: "2024-11-01T11:01:00Z",
    contentHash: "abc006",
    extractedFact: "Portfolio describes an analytics dashboard with D3.js visualizations and data queries. No NL query interface mentioned.",
    quotedExcerpt: "interactive data visualizations with D3.js",
    confidence: 0.40,
  },
  // No signals for ac-3 (PayPal) for candidate-2 → unknown

  // Candidate 3 — sparse evidence
  {
    id: "sig-c3-1",
    candidateId: "candidate-3",
    requirementId: "ac-1",
    signalType: "portfolio",
    sourceUrl: "https://samokafor.com",
    retrievedAt: "2024-11-01T12:00:00Z",
    contentHash: "abc007",
    extractedFact: "Portfolio mentions React projects but no performance benchmarks or load time data found.",
    quotedExcerpt: "built with React and Tailwind",
    confidence: 0.30,
  },
  // No signals for ac-2, ac-3 for candidate-3 → both unknown
];

async function seedVettingSignals() {
  console.log("🌱 Seeding Phase 5 vetting signals...");

  // 1. Grant consent for all demo candidates
  for (const candidateId of ["candidate-1", "candidate-2", "candidate-3"]) {
    await db
      .update(candidates)
      .set({
        vettingConsentAt: new Date("2024-11-01T09:00:00Z"),
        vettingRanAt: new Date("2024-11-01T10:30:00Z"),
        updatedAt: new Date(),
      })
      .where(eq(candidates.id, candidateId));
    console.log(`  ✓ Consent granted: ${candidateId}`);
  }

  // 2. Insert preloaded signals
  for (const sig of DEMO_SIGNALS) {
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
  console.log(`  ✓ Inserted ${DEMO_SIGNALS.length} preloaded signals`);

  // 3. Update trust scores from signals
  for (const candidateId of ["candidate-1", "candidate-2", "candidate-3"]) {
    const sigs = DEMO_SIGNALS.filter((s) => s.candidateId === candidateId);
    const score = computeTrustScore(sigs);
    const matrix = buildMatrix(REQUIREMENTS, sigs);
    const canDo = matrix
      .filter((e) => e.state === "can" || e.state === "partial")
      .map((e) => ({ skill: e.requirementDescription, state: e.state, evidenceSummary: e.evidenceSummary }));
    const cannotDo = matrix
      .filter((e) => e.state === "no")
      .map((e) => ({ skill: e.requirementDescription }));

    await db.update(candidates).set({
      trustScore: score.toFixed(2),
      canDo,
      cannotDo,
      updatedAt: new Date(),
    }).where(eq(candidates.id, candidateId));

    console.log(`  ✓ ${candidateId}: trustScore=${score.toFixed(2)}`);
  }

  // 4. One real, live GitHub lookup for the demo
  //    Using "vercel" org as a well-known public GitHub account
  //    (real data, no fake — demonstrates live GitHub lookup)
  console.log("\n  🔍 Attempting live GitHub lookup for demo (vercel org)...");
  try {
    const result = await fetchGitHubRepos("vercel");
    const repo = result.data[0];
    if (repo) {
      const liveSignal: Signal = {
        id: "sig-live-demo",
        candidateId: "candidate-1",
        requirementId: "ac-1",
        signalType: "github_repo",
        sourceUrl: repo.htmlUrl,
        retrievedAt: new Date().toISOString(),
        contentHash: `live-${Date.now()}`,
        extractedFact: `Live GitHub lookup: Found public repo "${repo.fullName}" — ${repo.description ?? "no description"}. Language: ${repo.language ?? "N/A"}, Stars: ${repo.stargazersCount}.`,
        quotedExcerpt: repo.description?.slice(0, 200) ?? repo.name,
        confidence: 0.30, // Low confidence — this is the vercel org, not the candidate's repo
      };

      await db.insert(signalsTable).values({
        ...liveSignal,
        retrievedAt: new Date(liveSignal.retrievedAt),
        confidence: liveSignal.confidence.toFixed(3),
      }).onConflictDoNothing();

      console.log(`  ✓ Live GitHub signal inserted: ${repo.fullName}`);
      console.log(`    Rate limit remaining: ${result.rateLimit?.remaining ?? "unknown"}`);
    }
  } catch (err) {
    console.log(`  ⚠ Live GitHub lookup skipped (offline or rate-limited): ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n✅ Phase 5 seed complete.");
}

seedVettingSignals().catch((err) => {
  console.error("❌ Phase 5 seed failed:", err);
  process.exit(1);
});
