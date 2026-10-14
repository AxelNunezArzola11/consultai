/**
 * Delivery Agent — Policy Engine
 *
 * PURE CODE. No LLM calls. No DB calls. No side effects.
 * Deterministically maps verification results to a policy decision.
 *
 * Decision values (in priority order):
 *   REJECT_RECOMMENDED     — one or more required objective criteria failed
 *   REQUIRES_APPROVAL      — any flag, any subjective criterion, amount above limit, or LLM-only path
 *   AUTO_RELEASE_ELIGIBLE  — all criteria objective + met + no flags + amount ≤ limit + SHA matches
 *
 * LLM output NEVER changes the decision. The LLM only provides justification text.
 *
 * The AUTO_RELEASE_LIMIT_USD default is 0 — disabled unless explicitly set.
 * This is intentionally fail-closed: auto-release is off by default.
 *
 * Rules from design spec:
 *  AUTO_RELEASE_ELIGIBLE only if:
 *    - every criterion is objective AND met
 *    - no flags raised
 *    - amount <= AUTO_RELEASE_LIMIT_USD
 *    - head SHA still matches at decision time (caller must re-fetch and pass in)
 *  REQUIRES_APPROVAL if:
 *    - any criterion is subjective, OR
 *    - any flag, OR
 *    - amount > AUTO_RELEASE_LIMIT_USD, OR
 *    - not all objective criteria are met (but none failed — partial)
 *  REJECT_RECOMMENDED if:
 *    - any objective criterion is explicitly met=false (failed)
 */

export type PolicyDecision =
  | "AUTO_RELEASE_ELIGIBLE"
  | "REQUIRES_APPROVAL"
  | "REJECT_RECOMMENDED";

export interface CriterionResult {
  criterionId: string;
  /** "objective" = deterministic code check; "subjective" = requires human judgment */
  kind: "objective" | "subjective";
  /**
   * true  = met
   * false = failed (objective only; triggers REJECT_RECOMMENDED)
   * null  = not assessed (e.g. check pending)
   */
  met: boolean | null;
  /** Evidence references — validated against fetched PR data */
  evidence: string[];
}

export type PolicyFlag =
  | "WORKFLOW_FILE_MODIFIED"
  | "TEST_FILE_DELETED"
  | "DRAFT_PR"
  | "WRONG_AUTHOR"
  | "SHA_MISMATCH";

export interface PolicyInput {
  criteriaResults: CriterionResult[];
  flags: PolicyFlag[];
  amountUsd: number;
  /** AUTO_RELEASE_LIMIT_USD from env, default 0 */
  autoReleaseLimitUsd: number;
  /** True if current head SHA matches the bound SHA (caller re-fetches) */
  shaMatches: boolean;
}

export interface PolicyOutput {
  decision: PolicyDecision;
  reasons: string[];
}

/**
 * Evaluates the policy engine and returns a decision + human-readable reasons.
 * Pure function — no I/O.
 */
export function evaluatePolicy(input: PolicyInput): PolicyOutput {
  const reasons: string[] = [];

  // 1. Check for hard-fail: any objective criterion met=false
  const failedObjective = input.criteriaResults.filter(
    (c) => c.kind === "objective" && c.met === false
  );
  if (failedObjective.length > 0) {
    reasons.push(
      `${failedObjective.length} required objective criterion/criteria failed: ` +
        failedObjective.map((c) => c.criterionId).join(", ")
    );
    return { decision: "REJECT_RECOMMENDED", reasons };
  }

  // From here: no hard fails. Collect REQUIRES_APPROVAL reasons.

  // 2. Flags
  if (input.flags.length > 0) {
    reasons.push(`Flags raised: ${input.flags.join(", ")}`);
  }

  // 3. Subjective criteria
  const subjectiveCriteria = input.criteriaResults.filter(
    (c) => c.kind === "subjective"
  );
  if (subjectiveCriteria.length > 0) {
    reasons.push(
      `${subjectiveCriteria.length} subjective criterion/criteria require human review: ` +
        subjectiveCriteria.map((c) => c.criterionId).join(", ")
    );
  }

  // 4. Null/unmet objective criteria (not failed, but not confirmed)
  const unmetObjective = input.criteriaResults.filter(
    (c) => c.kind === "objective" && c.met === null
  );
  if (unmetObjective.length > 0) {
    reasons.push(
      `${unmetObjective.length} objective criterion/criteria unassessed: ` +
        unmetObjective.map((c) => c.criterionId).join(", ")
    );
  }

  // 5. Amount limit
  if (input.amountUsd > input.autoReleaseLimitUsd) {
    reasons.push(
      `Amount $${input.amountUsd.toFixed(2)} exceeds auto-release limit ` +
        `$${input.autoReleaseLimitUsd.toFixed(2)}`
    );
  }

  // 6. SHA mismatch
  if (!input.shaMatches) {
    reasons.push("Head SHA changed after verification — re-verification required");
  }

  // If any REQUIRES_APPROVAL reason exists → REQUIRES_APPROVAL
  if (reasons.length > 0) {
    return { decision: "REQUIRES_APPROVAL", reasons };
  }

  // All criteria objective + met, no flags, amount ≤ limit, SHA matches
  return { decision: "AUTO_RELEASE_ELIGIBLE", reasons: ["All criteria met"] };
}

/**
 * Returns the AUTO_RELEASE_LIMIT_USD from env.
 * Default: 0 (disabled — auto-release off unless explicitly set).
 */
export function getAutoReleaseLimitUsd(): number {
  const raw = process.env.AUTO_RELEASE_LIMIT_USD;
  if (!raw) return 0;
  const n = parseFloat(raw);
  return isNaN(n) ? 0 : n;
}
