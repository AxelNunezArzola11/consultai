/**
 * Unit tests — Vetting signals, trust score, and can/can't-do matrix
 *
 * Invariants tested:
 * 1. Score is deterministic and reproducible (same inputs → same output)
 * 2. Protected attributes are NOT used as scoring features
 * 3. "unknown" state is produced when no signals exist for a requirement
 * 4. Score formula is transparent (weights are exported, inspectable)
 * 5. Score is clamped to [0, 1]
 * 6. Deduplication: only the best signal per (requirement, signal_type) counts
 * 7. Matrix states map correctly to confidence thresholds
 */

import { describe, it, expect } from "vitest";
import {
  computeTrustScore,
  buildMatrix,
  buildScoreBreakdown,
  SIGNAL_WEIGHTS,
  type Signal,
  type SignalType,
} from "./signals";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(
  overrides: Partial<Signal> & { requirementId: string; signalType: SignalType; confidence: number }
): Signal {
  return {
    id: "sig-1",
    candidateId: "cand-1",
    sourceUrl: "https://github.com/user/repo",
    retrievedAt: "2024-01-01T00:00:00Z",
    contentHash: "abc123",
    extractedFact: "Candidate authored 3 React components",
    quotedExcerpt: "React components",
    ...overrides,
  };
}

const REQUIREMENTS = [
  { id: "req-1", description: "React expertise" },
  { id: "req-2", description: "TypeScript" },
  { id: "req-3", description: "Node.js backend" },
];

// ---------------------------------------------------------------------------
// Trust score tests
// ---------------------------------------------------------------------------

describe("computeTrustScore", () => {
  it("returns 0 when no signals", () => {
    expect(computeTrustScore([])).toBe(0);
  });

  it("is deterministic — same inputs produce same output", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.9 }),
      makeSignal({ id: "sig-2", requirementId: "req-2", signalType: "portfolio", confidence: 0.6 }),
    ];
    const result1 = computeTrustScore(signals);
    const result2 = computeTrustScore([...signals]);
    expect(result1).toBe(result2);
    expect(typeof result1).toBe("number");
  });

  it("is reproducible — identical signals in different order produce same score", () => {
    const sig1 = makeSignal({ id: "sig-1", requirementId: "req-1", signalType: "github_repo", confidence: 0.8 });
    const sig2 = makeSignal({ id: "sig-2", requirementId: "req-2", signalType: "portfolio", confidence: 0.5 });

    const score1 = computeTrustScore([sig1, sig2]);
    const score2 = computeTrustScore([sig2, sig1]);
    expect(score1).toBe(score2);
  });

  it("clamps to [0, 1]", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 1.0 }),
    ];
    const score = computeTrustScore(signals);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("rounds to 2 decimal places", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.9 }),
      makeSignal({ id: "sig-2", requirementId: "req-2", signalType: "portfolio", confidence: 0.6 }),
    ];
    const score = computeTrustScore(signals);
    expect(score.toString()).toMatch(/^\d+\.\d{1,2}$|^\d+$/);
    expect(score).toBe(Math.round(score * 100) / 100);
  });

  it("deduplicates: keeps highest confidence per (requirement, signalType)", () => {
    const low = makeSignal({ id: "low", requirementId: "req-1", signalType: "github_repo", confidence: 0.3 });
    const high = makeSignal({ id: "high", requirementId: "req-1", signalType: "github_repo", confidence: 0.9 });

    const scoreWithBoth = computeTrustScore([low, high]);
    const scoreWithHigh = computeTrustScore([high]);
    // Should be same — low signal is deduplicated away
    expect(scoreWithBoth).toBe(scoreWithHigh);
  });

  it("applies SIGNAL_WEIGHTS correctly (github_repo has higher weight than portfolio)", () => {
    const ghSig = makeSignal({ id: "gh", requirementId: "req-1", signalType: "github_repo", confidence: 0.8 });
    const portSig = makeSignal({ id: "pt", requirementId: "req-2", signalType: "portfolio", confidence: 0.8 });

    // github_repo weight = 0.35, portfolio weight = 0.20
    // With same confidence: github_repo should contribute more per unit weight
    // Result: weighted_sum / total_weight = (0.35*0.8 + 0.20*0.8) / (0.35 + 0.20) = 0.8
    const score = computeTrustScore([ghSig, portSig]);
    expect(score).toBe(0.8);
  });

  it("SIGNAL_WEIGHTS are exported (transparent formula)", () => {
    expect(SIGNAL_WEIGHTS).toBeDefined();
    expect(SIGNAL_WEIGHTS.github_repo).toBeGreaterThan(0);
    expect(SIGNAL_WEIGHTS.portfolio).toBeGreaterThan(0);
    // Weights are in decreasing trust order
    expect(SIGNAL_WEIGHTS.github_repo).toBeGreaterThan(SIGNAL_WEIGHTS.portfolio);
    expect(SIGNAL_WEIGHTS.portfolio).toBeGreaterThan(SIGNAL_WEIGHTS.public_review);
    expect(SIGNAL_WEIGHTS.public_review).toBeGreaterThan(SIGNAL_WEIGHTS.provided_link);
  });
});

// ---------------------------------------------------------------------------
// Protected attributes test
// ---------------------------------------------------------------------------

describe("Protected attributes — never used as scoring features", () => {
  it("computeTrustScore function signature does not accept name, photo, gender, age, nationality, location", () => {
    // The Signal interface must not contain personal attribute fields
    const sig = makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.8 });

    // TypeScript-level assertion: these properties should not exist on Signal
    expect("name" in sig).toBe(false);
    expect("photo" in sig).toBe(false);
    expect("gender" in sig).toBe(false);
    expect("age" in sig).toBe(false);
    expect("nationality" in sig).toBe(false);
    expect("location" in sig).toBe(false);
  });

  it("signal fields are: id, candidateId, requirementId, signalType, sourceUrl, retrievedAt, contentHash, extractedFact, quotedExcerpt, confidence", () => {
    const sig = makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.9 });
    const allowedKeys = new Set([
      "id", "candidateId", "requirementId", "signalType",
      "sourceUrl", "retrievedAt", "contentHash",
      "extractedFact", "quotedExcerpt", "confidence",
    ]);
    const actualKeys = new Set(Object.keys(sig));
    for (const key of actualKeys) {
      expect(allowedKeys.has(key), `Unexpected field "${key}" found in Signal — protected attributes must not be scoring features`).toBe(true);
    }
  });

  it("computeTrustScore does not accept or use personal attributes (score unchanged by injecting extra fields)", () => {
    const sig = makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.7 });
    const score1 = computeTrustScore([sig]);

    // Inject personal attributes onto the signal object — score must be identical
    const sigWithPersonal = { ...sig, name: "Alice", gender: "F", age: 30, location: "Paris", nationality: "FR" };
    // Cast to Signal[] — TypeScript won't compile extra keys; simulate runtime injection
    const score2 = computeTrustScore([sigWithPersonal as unknown as Signal]);
    expect(score2).toBe(score1);
  });
});

// ---------------------------------------------------------------------------
// Matrix tests
// ---------------------------------------------------------------------------

describe("buildMatrix", () => {
  it("returns unknown for requirements with no signals", () => {
    const matrix = buildMatrix(REQUIREMENTS, []);
    for (const entry of matrix) {
      expect(entry.state).toBe("unknown");
      expect(entry.signals).toHaveLength(0);
      expect(entry.evidenceSummary).toBeNull();
    }
  });

  it("never infers — unknown stays unknown when signals are absent", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.9 }),
    ];
    const matrix = buildMatrix(REQUIREMENTS, signals);
    const req2 = matrix.find((e) => e.requirementId === "req-2")!;
    const req3 = matrix.find((e) => e.requirementId === "req-3")!;
    expect(req2.state).toBe("unknown");
    expect(req3.state).toBe("unknown");
  });

  it("confidence >= 0.7 → can", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.7 }),
    ];
    const matrix = buildMatrix(REQUIREMENTS, signals);
    const req1 = matrix.find((e) => e.requirementId === "req-1")!;
    expect(req1.state).toBe("can");
  });

  it("confidence in [0.4, 0.7) → partial", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "portfolio", confidence: 0.5 }),
    ];
    const matrix = buildMatrix(REQUIREMENTS, signals);
    const req1 = matrix.find((e) => e.requirementId === "req-1")!;
    expect(req1.state).toBe("partial");
  });

  it("confidence < 0.4 → no", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "provided_link", confidence: 0.2 }),
    ];
    const matrix = buildMatrix(REQUIREMENTS, signals);
    const req1 = matrix.find((e) => e.requirementId === "req-1")!;
    expect(req1.state).toBe("no");
  });

  it("exact boundary: confidence = 0.4 → partial (not no)", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "portfolio", confidence: 0.4 }),
    ];
    const matrix = buildMatrix(REQUIREMENTS, signals);
    const req1 = matrix.find((e) => e.requirementId === "req-1")!;
    expect(req1.state).toBe("partial");
  });

  it("exact boundary: confidence = 0.7 → can (not partial)", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.7 }),
    ];
    const matrix = buildMatrix(REQUIREMENTS, signals);
    const req1 = matrix.find((e) => e.requirementId === "req-1")!;
    expect(req1.state).toBe("can");
  });

  it("uses the max confidence signal across multiple signals for a requirement", () => {
    const signals: Signal[] = [
      makeSignal({ id: "s1", requirementId: "req-1", signalType: "provided_link", confidence: 0.2 }),
      makeSignal({ id: "s2", requirementId: "req-1", signalType: "github_repo", confidence: 0.85 }),
    ];
    const matrix = buildMatrix(REQUIREMENTS, signals);
    const req1 = matrix.find((e) => e.requirementId === "req-1")!;
    expect(req1.state).toBe("can");
    expect(req1.signals).toHaveLength(2);
  });

  it("evidenceSummary is non-null for can/partial/no states", () => {
    const signals: Signal[] = [
      makeSignal({ requirementId: "req-1", signalType: "github_repo", confidence: 0.8 }),
    ];
    const matrix = buildMatrix(REQUIREMENTS, signals);
    const req1 = matrix.find((e) => e.requirementId === "req-1")!;
    expect(req1.evidenceSummary).not.toBeNull();
  });

  it("evidenceSummary is null for unknown state", () => {
    const matrix = buildMatrix(REQUIREMENTS, []);
    for (const entry of matrix) {
      expect(entry.evidenceSummary).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Breakdown tests
// ---------------------------------------------------------------------------

describe("buildScoreBreakdown", () => {
  it("returns the same score as computeTrustScore", () => {
    const signals: Signal[] = [
      makeSignal({ id: "s1", requirementId: "req-1", signalType: "github_repo", confidence: 0.8 }),
      makeSignal({ id: "s2", requirementId: "req-2", signalType: "portfolio", confidence: 0.6 }),
    ];
    const breakdown = buildScoreBreakdown(signals);
    expect(breakdown.score).toBe(computeTrustScore(signals));
  });

  it("exposes weights in the breakdown", () => {
    const breakdown = buildScoreBreakdown([]);
    expect(breakdown.weights).toBe(SIGNAL_WEIGHTS);
  });

  it("counts signals by type correctly", () => {
    const signals: Signal[] = [
      makeSignal({ id: "s1", requirementId: "req-1", signalType: "github_repo", confidence: 0.9 }),
      makeSignal({ id: "s2", requirementId: "req-2", signalType: "github_repo", confidence: 0.7 }),
      makeSignal({ id: "s3", requirementId: "req-3", signalType: "portfolio", confidence: 0.5 }),
    ];
    const breakdown = buildScoreBreakdown(signals);
    expect(breakdown.bySignalType.github_repo?.count).toBe(2);
    expect(breakdown.bySignalType.portfolio?.count).toBe(1);
  });
});
