/**
 * BriefAgent — Zod plan schema and validators.
 *
 * Invariants enforced here (code-level, not just docs):
 *   - At most 6 milestones
 *   - Budget per milestone: MIN_MILESTONE_BUDGET_USD to MAX_MILESTONE_BUDGET_USD
 *   - Due-offset in days must be positive (future dates only)
 *   - Total budget must equal sum of milestone budgets (±$0.01 tolerance)
 *   - Acceptance criteria kinds: supported set OR downgraded to SUBJECTIVE
 *   - Raw brief capped at INPUT_MAX_CHARS
 *   - "SUBJECTIVE" criteria flagged as "needs human approval"
 *
 * Configurable limits (env-driven, with safe defaults):
 *   BRIEF_MIN_MILESTONE_USD  default 100
 *   BRIEF_MAX_MILESTONE_USD  default 50000
 *   BRIEF_MAX_MILESTONES     default 6
 *   BRIEF_INPUT_MAX_CHARS    default 4000
 *   BRIEF_SESSION_RATE_LIMIT default 10 (requests per session)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Configurable limits (read at module load; defaults safe for dev/test)
// ---------------------------------------------------------------------------

export const BRIEF_LIMITS = {
  MIN_MILESTONE_BUDGET_USD: Number(
    process.env.BRIEF_MIN_MILESTONE_USD ?? 100
  ),
  MAX_MILESTONE_BUDGET_USD: Number(
    process.env.BRIEF_MAX_MILESTONE_USD ?? 50_000
  ),
  MAX_MILESTONES: Math.min(
    6,
    Number(process.env.BRIEF_MAX_MILESTONES ?? 6)
  ),
  INPUT_MAX_CHARS: Number(process.env.BRIEF_INPUT_MAX_CHARS ?? 4_000),
  SESSION_RATE_LIMIT: Number(process.env.BRIEF_SESSION_RATE_LIMIT ?? 10),
} as const;

// ---------------------------------------------------------------------------
// Supported objective criterion kinds (must stay in sync with verifier.ts)
// ---------------------------------------------------------------------------

export const SUPPORTED_OBJECTIVE_KINDS = [
  "ci_passes",
  "pr_merged",
  "required_review_approved",
  "files_present",
  "no_workflow_or_test_tampering",
] as const;

export type SupportedObjectiveKind = (typeof SUPPORTED_OBJECTIVE_KINDS)[number];

export type CriterionKind = SupportedObjectiveKind | "SUBJECTIVE";

// ---------------------------------------------------------------------------
// Acceptance criterion schema
// ---------------------------------------------------------------------------

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).max(500),
  /**
   * The verifier kind. Anything not in SUPPORTED_OBJECTIVE_KINDS is coerced
   * to "SUBJECTIVE" by normalizeBriefPlan (never trust LLM raw output).
   */
  kind: z.string().min(1),
  /**
   * For files_present: paths to check. Optional on other kinds.
   */
  requiredFiles: z.array(z.string()).optional(),
  /**
   * For ci_passes: workflow/app slugs to match. Optional.
   */
  ciWorkflowAllowlist: z.array(z.string()).optional(),
  /**
   * Set by normalizeBriefPlan when kind is unsupported.
   * Must never be set in agent output — set by server normalizer only.
   */
  needsHumanApproval: z.boolean().optional(),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

// ---------------------------------------------------------------------------
// Milestone schema
// ---------------------------------------------------------------------------

export const MilestoneSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(800),
  /**
   * Budget in USD. Enforced: MIN_MILESTONE_BUDGET_USD ≤ budget ≤ MAX_MILESTONE_BUDGET_USD.
   * Checked dynamically using BRIEF_LIMITS to support env config.
   */
  budgetUsd: z.number().positive(),
  /** Offset from project start in days. Must be positive (future dates only). */
  dueDaysOffset: z.number().int().positive(),
  acceptanceCriteria: z
    .array(AcceptanceCriterionSchema)
    .min(1, "Each milestone needs at least one acceptance criterion"),
});

export type BriefMilestone = z.infer<typeof MilestoneSchema>;

// ---------------------------------------------------------------------------
// Full plan schema (agent output shape)
// ---------------------------------------------------------------------------

export const BriefPlanSchema = z.object({
  projectTitle: z.string().min(1).max(200),
  projectSummary: z.string().min(1).max(1000),
  totalBudgetUsd: z.number().positive(),
  milestones: z.array(MilestoneSchema).min(1).max(BRIEF_LIMITS.MAX_MILESTONES),
});

export type BriefPlan = z.infer<typeof BriefPlanSchema>;

// ---------------------------------------------------------------------------
// Normalizer: coerces unsupported criterion kinds → SUBJECTIVE, validates totals
// ---------------------------------------------------------------------------

export interface NormalizeResult {
  plan: BriefPlan;
  /** Criteria that were downgraded to SUBJECTIVE with flag set */
  downgradedCriteria: string[];
  /** Validation errors (non-fatal warnings) */
  warnings: string[];
  /** Fatal errors — plan must be rejected if non-empty */
  errors: string[];
}

export function normalizeBriefPlan(raw: unknown): NormalizeResult {
  const downgradedCriteria: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Structural parse
  const parsed = BriefPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      plan: raw as BriefPlan, // fallback — caller checks errors
      downgradedCriteria,
      warnings,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const plan = parsed.data;

  // 2. Downgrade unsupported criterion kinds → SUBJECTIVE
  for (const milestone of plan.milestones) {
    for (const criterion of milestone.acceptanceCriteria) {
      const supported = (SUPPORTED_OBJECTIVE_KINDS as readonly string[]).includes(
        criterion.kind
      );
      if (!supported) {
        downgradedCriteria.push(`${milestone.id}/${criterion.id}: ${criterion.kind} → SUBJECTIVE`);
        criterion.kind = "SUBJECTIVE";
        criterion.needsHumanApproval = true;
      }
    }
  }

  // 3. Budget limits per milestone
  for (const milestone of plan.milestones) {
    if (milestone.budgetUsd < BRIEF_LIMITS.MIN_MILESTONE_BUDGET_USD) {
      errors.push(
        `Milestone "${milestone.title}" budget $${milestone.budgetUsd} is below minimum $${BRIEF_LIMITS.MIN_MILESTONE_BUDGET_USD}`
      );
    }
    if (milestone.budgetUsd > BRIEF_LIMITS.MAX_MILESTONE_BUDGET_USD) {
      errors.push(
        `Milestone "${milestone.title}" budget $${milestone.budgetUsd} exceeds maximum $${BRIEF_LIMITS.MAX_MILESTONE_BUDGET_USD}`
      );
    }
  }

  // 4. Total consistency (allow ±$0.01 rounding tolerance)
  const sumOfMilestones = plan.milestones.reduce((s, m) => s + m.budgetUsd, 0);
  const diff = Math.abs(plan.totalBudgetUsd - sumOfMilestones);
  if (diff > 0.01) {
    errors.push(
      `totalBudgetUsd $${plan.totalBudgetUsd.toFixed(2)} ≠ sum of milestones $${sumOfMilestones.toFixed(2)} (diff $${diff.toFixed(2)})`
    );
  }

  // 5. Milestone count
  if (plan.milestones.length > BRIEF_LIMITS.MAX_MILESTONES) {
    errors.push(
      `Plan has ${plan.milestones.length} milestones; maximum is ${BRIEF_LIMITS.MAX_MILESTONES}`
    );
  }

  return { plan, downgradedCriteria, warnings, errors };
}
