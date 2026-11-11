/**
 * Vetting run feedback — decides what the UI tells the user after a
 * vetting run that returned HTTP 200.
 *
 * A run can succeed at HTTP level yet produce zero signals (e.g. GitHub
 * rate limit with no LLM fallback engaged). Without this, users see
 * "Vetting complete" next to a 0-point score and no reason why.
 */

export interface VettingRunFeedbackInput {
  signalCount?: number;
  usedFallback?: boolean;
  errors?: string[];
}

export type VettingRunFeedbackResult =
  | { kind: "ok" }
  | { kind: "empty"; message: string };

export function vettingRunFeedback(
  input: VettingRunFeedbackInput
): VettingRunFeedbackResult {
  const errors = (input.errors ?? []).filter(
    (e): e is string => typeof e === "string" && e.trim().length > 0
  );
  if (errors.length === 0) return { kind: "ok" };

  if (input.usedFallback) {
    return {
      kind: "empty",
      message: `LLM unavailable — scores will be 0. Reason: ${errors[0]}`,
    };
  }

  if ((input.signalCount ?? 0) === 0) {
    return {
      kind: "empty",
      message: `Vetting found no signals — scores are 0. Reason: ${errors[0]}`,
    };
  }

  // Partial success: keep the existing success UX (some errors are benign,
  // e.g. LinkedIn display-only links or one failed repo detail fetch).
  return { kind: "ok" };
}
