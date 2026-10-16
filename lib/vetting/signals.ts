/**
 * Vetting Agent — Signals table extension and trust score formula
 *
 * The signals table extends the existing evidence table with the richer fields
 * required by the vetting agent:
 *   candidate_id, requirement_id, signal_type, source_url, retrieved_at,
 *   content_hash, extracted_fact, quoted_excerpt
 *
 * Design invariants:
 * 1. Trust score is computed in CODE from signals — not by the LLM.
 *    The formula is deterministic and reproducible.
 * 2. Weights are exported (shown in UI).
 * 3. Protected attributes (name, photo, gender, age, nationality, location)
 *    are NEVER used as scoring features — asserted in tests.
 * 4. "unknown" is a valid matrix state; we never infer.
 * 5. Score = Σ(weight_i × confidence_i) / Σ(weight_i)  for matched signals,
 *    then clamped to [0, 1] and rounded to 2dp.
 */

// ---------------------------------------------------------------------------
// Signal types and weights
// ---------------------------------------------------------------------------

/** Signal type → weight used in trust score formula */
export const SIGNAL_WEIGHTS = {
  /** GitHub repository owned by the candidate demonstrating the skill */
  github_repo: 0.35,
  /** GitHub PR authored by the candidate (in an external repo or their own) */
  github_pr: 0.30,
  /** Candidate-provided portfolio page (SSRF-safe fetch) */
  portfolio: 0.20,
  /** Public review page provided by the candidate */
  public_review: 0.10,
  /** Other candidate-provided link (lower trust weight) */
  provided_link: 0.05,
} as const;

export type SignalType = keyof typeof SIGNAL_WEIGHTS;

/**
 * A single vetting signal.
 *
 * Fields map 1:1 to the signals DB columns.
 * Every signal links to its source URL.
 * quoted_excerpt must be verified to exist in fetched content before storing.
 */
export interface Signal {
  id: string;
  candidateId: string;
  /** Links a signal to a specific acceptance-criterion requirement */
  requirementId: string;
  signalType: SignalType;
  sourceUrl: string;
  retrievedAt: string; // ISO-8601
  /** SHA-256 hex of the fetched content (for cache validation) */
  contentHash: string;
  /** Fact extracted from the content by the LLM (code-verified) */
  extractedFact: string;
  /** Verbatim excerpt quoted from source; verified to exist in fetched content */
  quotedExcerpt: string;
  /**
   * Confidence that the signal satisfies the requirement.
   * Set by code based on structured LLM output (validated against content).
   * Range: 0–1.
   */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Can/can't-do matrix
// ---------------------------------------------------------------------------

/** States for the can/can't-do matrix */
export type MatrixState = "can" | "partial" | "unknown" | "no";

export interface MatrixEntry {
  requirementId: string;
  requirementDescription: string;
  state: MatrixState;
  /** Signals that support this entry */
  signals: Signal[];
  /**
   * Human-readable evidence summary.
   * null when state is "unknown" — never inferred.
   */
  evidenceSummary: string | null;
}

// ---------------------------------------------------------------------------
// Trust score formula
// ---------------------------------------------------------------------------

/**
 * Compute trust score from signals.
 *
 * Formula (transparent, shown in UI):
 *   For each requirement, find the highest-confidence signal.
 *   Weighted score = Σ( SIGNAL_WEIGHTS[signal_type] × confidence ) / Σ(SIGNAL_WEIGHTS[signal_type])
 *   Clamp to [0, 1], round to 2dp.
 *
 * If no signals exist: returns 0.
 *
 * Design invariant: no personal attributes involved.
 */
export function computeTrustScore(signals: Signal[]): number {
  if (signals.length === 0) return 0;

  // Deduplicate: keep the highest-confidence signal per (requirementId, signalType)
  const best = new Map<string, Signal>();
  for (const sig of signals) {
    const key = `${sig.requirementId}:${sig.signalType}`;
    const existing = best.get(key);
    if (!existing || sig.confidence > existing.confidence) {
      best.set(key, sig);
    }
  }

  const deduped = Array.from(best.values());

  let weightedSum = 0;
  let totalWeight = 0;

  for (const sig of deduped) {
    const w = SIGNAL_WEIGHTS[sig.signalType];
    weightedSum += w * sig.confidence;
    totalWeight += w;
  }

  if (totalWeight === 0) return 0;

  const raw = weightedSum / totalWeight;
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * 100) / 100;
}

// ---------------------------------------------------------------------------
// Matrix builder
// ---------------------------------------------------------------------------

/**
 * Build the can/can't-do matrix from requirements and signals.
 *
 * States:
 *   can     — at least one signal with confidence ≥ 0.7
 *   partial — highest confidence in [0.4, 0.7)
 *   no      — signals present but all confidence < 0.4
 *   unknown — no signals for this requirement
 *
 * "unknown" is never inferred — it means we have no evidence, period.
 */
export function buildMatrix(
  requirements: Array<{ id: string; description: string }>,
  signals: Signal[]
): MatrixEntry[] {
  return requirements.map((req) => {
    const reqSignals = signals.filter((s) => s.requirementId === req.id);

    if (reqSignals.length === 0) {
      return {
        requirementId: req.id,
        requirementDescription: req.description,
        state: "unknown" as MatrixState,
        signals: [],
        evidenceSummary: null,
      };
    }

    const maxConfidence = Math.max(...reqSignals.map((s) => s.confidence));

    let state: MatrixState;
    if (maxConfidence >= 0.7) {
      state = "can";
    } else if (maxConfidence >= 0.4) {
      state = "partial";
    } else {
      state = "no";
    }

    // Build evidence summary only when we have evidence (not unknown)
    const topSignal = reqSignals.find((s) => s.confidence === maxConfidence)!;
    const evidenceSummary =
      `${topSignal.extractedFact} (${topSignal.sourceUrl})`.slice(0, 400);

    return {
      requirementId: req.id,
      requirementDescription: req.description,
      state,
      signals: reqSignals,
      evidenceSummary,
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring breakdown (for UI)
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  score: number;
  weights: typeof SIGNAL_WEIGHTS;
  bySignalType: Record<SignalType, { count: number; avgConfidence: number }>;
  signalCount: number;
}

export function buildScoreBreakdown(signals: Signal[]): ScoreBreakdown {
  const byType = {} as Record<SignalType, { count: number; totalConf: number }>;

  for (const sig of signals) {
    if (!byType[sig.signalType]) {
      byType[sig.signalType] = { count: 0, totalConf: 0 };
    }
    byType[sig.signalType].count++;
    byType[sig.signalType].totalConf += sig.confidence;
  }

  const bySignalType = {} as Record<SignalType, { count: number; avgConfidence: number }>;
  for (const [type, data] of Object.entries(byType) as [SignalType, { count: number; totalConf: number }][]) {
    bySignalType[type] = {
      count: data.count,
      avgConfidence: data.count > 0 ? Math.round((data.totalConf / data.count) * 100) / 100 : 0,
    };
  }

  return {
    score: computeTrustScore(signals),
    weights: SIGNAL_WEIGHTS,
    bySignalType,
    signalCount: signals.length,
  };
}
