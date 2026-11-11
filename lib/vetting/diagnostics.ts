/**
 * Vetting run diagnostics — persisted per candidate after every vetting run.
 *
 * A vetting run can complete at HTTP level yet produce zero signals (LLM
 * unavailable, GitHub rate-limited, no verifiable evidence). Without a
 * durable record of WHY, every such candidate shows an identical unexplained
 * "0 pts". These diagnostics are stored on the candidate row
 * (`vetting_diagnostics` jsonb) and rendered persistently on the vetting
 * card so the reason survives page refreshes.
 *
 * Client-safe: pure types + functions only, no database imports.
 */

export interface VettingDiagnostics {
  /** ISO-8601 timestamp of the run that produced these diagnostics */
  ranAt: string;
  /** Number of evidence signals extracted and persisted */
  signalCount: number;
  /** True when the LLM was unavailable and the deterministic fallback ran */
  usedFallback: boolean;
  /** LLM matches dropped because the quoted excerpt was not verbatim */
  fabricatedDropped: number;
  /** Full names (owner/repo) of the repos analyzed, most prominent first */
  reposAnalyzed: string[];
  /** Non-fatal errors collected during the run (capped, newest last) */
  errors: string[];
}

export const EMPTY_VETTING_DIAGNOSTICS: VettingDiagnostics = {
  ranAt: "",
  signalCount: 0,
  usedFallback: false,
  fabricatedDropped: 0,
  reposAnalyzed: [],
  errors: [],
};

/**
 * Safely parse a diagnostics payload from the database (jsonb can hold
 * anything). Returns null when the value is absent or not a recognizable
 * diagnostics object — never throws.
 */
export function parseVettingDiagnostics(
  value: unknown
): VettingDiagnostics | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.ranAt !== "string" ||
    typeof v.signalCount !== "number" ||
    typeof v.usedFallback !== "boolean" ||
    typeof v.fabricatedDropped !== "number" ||
    !Array.isArray(v.reposAnalyzed) ||
    !Array.isArray(v.errors)
  ) {
    return null;
  }
  return {
    ranAt: v.ranAt,
    signalCount: v.signalCount,
    usedFallback: v.usedFallback,
    fabricatedDropped: v.fabricatedDropped,
    reposAnalyzed: v.reposAnalyzed.filter(
      (r): r is string => typeof r === "string"
    ),
    errors: v.errors.filter((e): e is string => typeof e === "string"),
  };
}

export type VettingBannerTone = "error" | "warn" | "info" | null;

export interface VettingBanner {
  tone: VettingBannerTone;
  title: string;
  detail: string | null;
}

/**
 * Build the persistent card banner for a vetting result.
 *
 * Priority:
 *  1. LLM fallback engaged → error (scores are definitionally 0).
 *  2. Zero signals with errors → error (fetch/extraction failed).
 *  3. Zero signals without errors → info (honest "unknown": no verifiable
 *     evidence in the analyzed repos — never inferred).
 *  4. Signals present + benign errors → warn.
 *  5. Clean run → null (no banner).
 */
export function describeVettingDiagnostics(
  diagnostics: VettingDiagnostics | null,
  trustScore: number | null
): VettingBanner | null {
  if (!diagnostics || !diagnostics.ranAt) return null;
  const firstError = diagnostics.errors[0] ?? null;

  if (diagnostics.usedFallback) {
    return {
      tone: "error",
      title: "Vetting incomplete — AI analysis unavailable",
      detail:
        (firstError ? `${firstError} ` : "") +
        "No evidence could be extracted, so the score is 0. Fix the cause, then Re-run.",
    };
  }

  if (diagnostics.signalCount === 0 && diagnostics.errors.length > 0) {
    return {
      tone: "error",
      title: "Vetting found no verifiable evidence",
      detail:
        `${firstError} ` +
        "Scores stay 0 until at least one source succeeds. Fix the cause, then Re-run.",
    };
  }

  if (diagnostics.signalCount === 0) {
    const reposBit =
      diagnostics.reposAnalyzed.length > 0
        ? ` Analyzed ${diagnostics.reposAnalyzed.length} repositor` +
          (diagnostics.reposAnalyzed.length === 1 ? "y" : "ies") +
          ` (${diagnostics.reposAnalyzed.slice(0, 3).join(", ")}${
            diagnostics.reposAnalyzed.length > 3 ? ", …" : ""
          }) with no quotable match for the project requirements.`
        : "";
    const droppedBit =
      diagnostics.fabricatedDropped > 0
        ? ` ${diagnostics.fabricatedDropped} candidate excerpt` +
          (diagnostics.fabricatedDropped === 1 ? " was" : "s were") +
          " rejected during verbatim verification."
        : "";
    return {
      tone: "info",
      title: "No public evidence matched — not inferred",
      detail:
        `The score is honestly 0: nothing quotable was found for these requirements.${reposBit}${droppedBit}`.trim() ||
        null,
    };
  }

  if (diagnostics.errors.length > 0) {
    return {
      tone: "warn",
      title: "Partial vetting — some sources failed",
      detail: `${firstError}${
        diagnostics.errors.length > 1
          ? ` (+${diagnostics.errors.length - 1} more)`
          : ""
      }`,
    };
  }

  if ((trustScore ?? 0) === 0 && diagnostics.fabricatedDropped > 0) {
    return {
      tone: "info",
      title: "Evidence rejected during verification",
      detail: `${diagnostics.fabricatedDropped} excerpt(s) were not verbatim quotes and were dropped.`,
    };
  }

  return null;
}
