/**
 * Delivery Agent — Deterministic Verifier
 *
 * Maps fetched GitHub PR data onto objective acceptance criteria.
 * All checks here are deterministic (no LLM). Pure function.
 *
 * Objective criterion kinds (from design spec):
 *   ci_passes            — all check runs completed=success (from CI allowlist)
 *   pr_merged            — PR is merged
 *   required_review_approved — at least one APPROVED review exists
 *   files_present        — specified files exist in PR changed files
 *   no_workflow_or_test_tampering — no .github/workflows or test files modified/deleted
 *
 * Flags raised by this module:
 *   WORKFLOW_FILE_MODIFIED — any .github/workflows/** file changed
 *   TEST_FILE_DELETED      — any *.test.* or __tests__ file deleted
 *   DRAFT_PR               — PR is a draft
 *   WRONG_AUTHOR           — PR author does not match expected freelancer
 *
 * UNVERIFIED note: Endpoint behavior is confirmed in GitHub docs but has not
 * been observed in the demo repo yet. Marked UNVERIFIED until first real run.
 */

import type {
  GitHubPR,
  GitHubFile,
  GitHubCheckRun,
  GitHubReview,
} from "./github-client";
import type { CriterionResult, PolicyFlag } from "./policy-engine";

// ---------------------------------------------------------------------------
// Criterion definitions (objective only — subjective are pass-through)
// ---------------------------------------------------------------------------

export type ObjectiveCriterionKind =
  | "ci_passes"
  | "pr_merged"
  | "required_review_approved"
  | "files_present"
  | "no_workflow_or_test_tampering";

export interface AcceptanceCriterion {
  id: string;
  description: string;
  /** "objective" criteria are deterministically checked; "subjective" are LLM-assessed */
  kind: "objective" | "subjective";
  /**
   * For objective criteria, the specific check type.
   * For "files_present": provide requiredFiles list.
   * For "ci_passes": optionally provide ciWorkflowAllowlist.
   */
  checkType?: ObjectiveCriterionKind;
  /** For files_present: list of required file paths (exact or glob) */
  requiredFiles?: string[];
  /** For ci_passes: only these workflow/app slugs count. If empty, all checks considered. */
  ciWorkflowAllowlist?: string[];
}

export interface VerificationContext {
  pr: GitHubPR;
  files: GitHubFile[];
  checkRuns: GitHubCheckRun[];
  reviews: GitHubReview[];
  /** Expected freelancer login (from project/milestone assignment) */
  expectedAuthor?: string;
}

// ---------------------------------------------------------------------------
// Flag detection
// ---------------------------------------------------------------------------

const WORKFLOW_PATTERN = /^\.github\/workflows\//i;
const TEST_FILE_PATTERN = /\.(test|spec)\.[jt]sx?$|__tests__\//i;

/**
 * Detects flags from the changed files and PR metadata.
 * UNVERIFIED: file pattern matching not yet tested against real demo repo.
 */
export function detectFlags(
  ctx: VerificationContext
): PolicyFlag[] {
  const flags: PolicyFlag[] = [];

  // Workflow file modified or deleted
  const workflowFiles = ctx.files.filter((f) => WORKFLOW_PATTERN.test(f.filename));
  if (workflowFiles.length > 0) {
    flags.push("WORKFLOW_FILE_MODIFIED");
    console.log(
      `[verifier] WORKFLOW_FILE_MODIFIED: ${workflowFiles.map((f) => f.filename).join(", ")}`
    );
  }

  // Test file deleted
  const deletedTestFiles = ctx.files.filter(
    (f) => f.status === "removed" && TEST_FILE_PATTERN.test(f.filename)
  );
  if (deletedTestFiles.length > 0) {
    flags.push("TEST_FILE_DELETED");
    console.log(
      `[verifier] TEST_FILE_DELETED: ${deletedTestFiles.map((f) => f.filename).join(", ")}`
    );
  }

  // Draft PR
  if (ctx.pr.draft) {
    flags.push("DRAFT_PR");
    console.log("[verifier] DRAFT_PR");
  }

  // Wrong author
  if (
    ctx.expectedAuthor &&
    ctx.pr.author.toLowerCase() !== ctx.expectedAuthor.toLowerCase()
  ) {
    flags.push("WRONG_AUTHOR");
    console.log(
      `[verifier] WRONG_AUTHOR: expected '${ctx.expectedAuthor}', got '${ctx.pr.author}'`
    );
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Objective criterion checks
// ---------------------------------------------------------------------------

function checkCiPasses(
  ctx: VerificationContext,
  criterion: AcceptanceCriterion
): CriterionResult {
  const allowlist = criterion.ciWorkflowAllowlist ?? [];

  // Filter to relevant check runs
  const relevant =
    allowlist.length > 0
      ? ctx.checkRuns.filter((c) => {
          const slug = c.app?.slug?.toLowerCase() ?? "";
          const name = c.name.toLowerCase();
          return allowlist.some(
            (a) => slug.includes(a.toLowerCase()) || name.includes(a.toLowerCase())
          );
        })
      : ctx.checkRuns;

  if (relevant.length === 0) {
    // No check runs found — could be CI not configured or allowlist too restrictive
    return {
      criterionId: criterion.id,
      kind: "objective",
      met: null,
      evidence: [],
    };
  }

  const failed = relevant.filter(
    (c) =>
      c.status === "completed" &&
      c.conclusion !== null &&
      c.conclusion !== "success" &&
      c.conclusion !== "neutral" &&
      c.conclusion !== "skipped"
  );

  const allCompleted = relevant.every((c) => c.status === "completed");
  const allPassed = allCompleted && failed.length === 0;

  return {
    criterionId: criterion.id,
    kind: "objective",
    met: allCompleted ? allPassed : null, // null if checks still running
    evidence: relevant.map((c) => `check:${c.name}=${c.conclusion ?? c.status}`),
  };
}

function checkPrMerged(
  ctx: VerificationContext,
  criterion: AcceptanceCriterion
): CriterionResult {
  return {
    criterionId: criterion.id,
    kind: "objective",
    met: ctx.pr.merged,
    evidence: ctx.pr.merged
      ? [`sha:${ctx.pr.headSha}`, `merged_at:${ctx.pr.mergedAt ?? "unknown"}`]
      : [`state:${ctx.pr.state}`, `merged:false`],
  };
}

function checkRequiredReviewApproved(
  ctx: VerificationContext,
  criterion: AcceptanceCriterion
): CriterionResult {
  const approved = ctx.reviews.filter((r) => r.state === "APPROVED");
  const met = approved.length > 0;

  return {
    criterionId: criterion.id,
    kind: "objective",
    met,
    evidence: approved.map((r) => `review:${r.id}:${r.user}:APPROVED`),
  };
}

function checkFilesPresent(
  ctx: VerificationContext,
  criterion: AcceptanceCriterion
): CriterionResult {
  const required = criterion.requiredFiles ?? [];
  if (required.length === 0) {
    return {
      criterionId: criterion.id,
      kind: "objective",
      met: true,
      evidence: ["no files specified — criterion vacuously met"],
    };
  }

  const changedFilenames = ctx.files.map((f) => f.filename);
  const evidence: string[] = [];
  let allPresent = true;

  for (const req of required) {
    const found = changedFilenames.some(
      (f) => f === req || f.startsWith(req.replace(/\*$/, ""))
    );
    evidence.push(`${req}:${found ? "present" : "missing"}`);
    if (!found) allPresent = false;
  }

  return {
    criterionId: criterion.id,
    kind: "objective",
    met: allPresent,
    evidence,
  };
}

function checkNoWorkflowOrTestTampering(
  ctx: VerificationContext,
  criterion: AcceptanceCriterion
): CriterionResult {
  const workflowFiles = ctx.files.filter((f) => WORKFLOW_PATTERN.test(f.filename));
  const deletedTestFiles = ctx.files.filter(
    (f) => f.status === "removed" && TEST_FILE_PATTERN.test(f.filename)
  );

  const tampered = [...workflowFiles, ...deletedTestFiles];
  const met = tampered.length === 0;

  return {
    criterionId: criterion.id,
    kind: "objective",
    met,
    evidence: tampered.length > 0
      ? tampered.map((f) => `tampered:${f.filename}:${f.status}`)
      : ["no workflow or test files modified"],
  };
}

// ---------------------------------------------------------------------------
// Main verifier
// ---------------------------------------------------------------------------

/**
 * Runs deterministic checks for all objective criteria.
 * Subjective criteria are returned as-is with met=null (to be assessed by LLM).
 * UNVERIFIED: not yet tested against real demo repo data.
 */
export function verifyObjectiveCriteria(
  criteria: AcceptanceCriterion[],
  ctx: VerificationContext
): CriterionResult[] {
  return criteria.map((criterion) => {
    if (criterion.kind === "subjective") {
      // Pass-through: subjective criteria are assessed by the LLM step
      return {
        criterionId: criterion.id,
        kind: "subjective" as const,
        met: null,
        evidence: [],
      };
    }

    switch (criterion.checkType) {
      case "ci_passes":
        return checkCiPasses(ctx, criterion);
      case "pr_merged":
        return checkPrMerged(ctx, criterion);
      case "required_review_approved":
        return checkRequiredReviewApproved(ctx, criterion);
      case "files_present":
        return checkFilesPresent(ctx, criterion);
      case "no_workflow_or_test_tampering":
        return checkNoWorkflowOrTestTampering(ctx, criterion);
      default:
        // Unknown check type — return null (unassessed)
        return {
          criterionId: criterion.id,
          kind: "objective" as const,
          met: null,
          evidence: [`unknown check type: ${criterion.checkType ?? "none"}`],
        };
    }
  });
}

/**
 * Validates that all evidence references in LLM output exist in fetched data.
 * Drops any fabricated references not present in the context.
 * Returns only validated refs.
 *
 * Evidence ref format: "kind:value" e.g. "check:CI/build=success", "sha:abc123"
 */
export function validateEvidenceRefs(
  llmRefs: string[],
  ctx: VerificationContext
): { valid: string[]; dropped: string[] } {
  // Build a set of all real evidence strings from the context
  const realEvidence = new Set<string>();

  ctx.checkRuns.forEach((c) => {
    realEvidence.add(`check:${c.name}`);
    realEvidence.add(c.name.toLowerCase());
  });

  ctx.files.forEach((f) => {
    realEvidence.add(`file:${f.filename}`);
    realEvidence.add(f.filename);
    realEvidence.add(f.sha);
  });

  ctx.reviews.forEach((r) => {
    realEvidence.add(`review:${r.id}`);
    realEvidence.add(String(r.id));
    realEvidence.add(r.user);
  });

  realEvidence.add(ctx.pr.headSha);
  realEvidence.add(ctx.pr.headSha.substring(0, 7));

  const valid: string[] = [];
  const dropped: string[] = [];

  for (const ref of llmRefs) {
    const lower = ref.toLowerCase();
    const found =
      realEvidence.has(ref) ||
      realEvidence.has(lower) ||
      // partial match: ref contains a known value
      [...realEvidence].some(
        (r) => r.length > 6 && (lower.includes(r.toLowerCase()) || r.toLowerCase().includes(lower))
      );

    if (found) {
      valid.push(ref);
    } else {
      console.warn(`[verifier] Dropping fabricated evidence ref: "${ref}"`);
      dropped.push(ref);
    }
  }

  return { valid, dropped };
}
