/**
 * Deterministic verifier unit tests
 *
 * Tests:
 * 1.  ci_passes: all checks success → met=true
 * 2.  ci_passes: one check failed → met=false
 * 3.  ci_passes: checks still running → met=null
 * 4.  ci_passes: no check runs → met=null
 * 5.  ci_passes: allowlist filters to relevant checks only
 * 6.  pr_merged: merged PR → met=true
 * 7.  pr_merged: open PR → met=false
 * 8.  required_review_approved: APPROVED review → met=true
 * 9.  required_review_approved: no reviews → met=false
 * 10. files_present: file in changed list → met=true
 * 11. files_present: file missing → met=false
 * 12. no_workflow_or_test_tampering: clean PR → met=true
 * 13. no_workflow_or_test_tampering: workflow file modified → met=false
 * 14. no_workflow_or_test_tampering: test file deleted → met=false
 * 15. detectFlags: WORKFLOW_FILE_MODIFIED raised
 * 16. detectFlags: TEST_FILE_DELETED raised
 * 17. detectFlags: DRAFT_PR raised
 * 18. detectFlags: WRONG_AUTHOR raised
 * 19. validateEvidenceRefs: valid refs kept, fabricated dropped
 * 20. subjective criterion passes through with met=null
 */

import { describe, it, expect } from "vitest";
import {
  detectFlags,
  verifyObjectiveCriteria,
  validateEvidenceRefs,
  type AcceptanceCriterion,
  type VerificationContext,
} from "./verifier";
import type { GitHubPR, GitHubFile, GitHubCheckRun, GitHubReview } from "./github-client";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 42,
    title: "feat: implement milestone",
    body: "Closes #1",
    state: "closed",
    merged: true,
    draft: false,
    headSha: "abc123def456abc123def456abc123def456abc1",
    headRef: "feat/milestone",
    baseRef: "main",
    author: "freelancer-alice",
    authorId: 1001,
    htmlUrl: "https://github.com/demo/repo/pull/42",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    mergedAt: "2024-01-02T00:00:00Z",
    ...overrides,
  };
}

function makeFile(filename: string, status: GitHubFile["status"] = "added"): GitHubFile {
  return {
    filename,
    status,
    additions: 10,
    deletions: 0,
    sha: "file-sha-" + filename.replace(/\W/g, "_"),
    rawUrl: null,
  };
}

function makeCheck(
  name: string,
  conclusion: GitHubCheckRun["conclusion"],
  status: GitHubCheckRun["status"] = "completed"
): GitHubCheckRun {
  return {
    id: Math.floor(Math.random() * 99999),
    name,
    app: { slug: "github-actions", id: 15368 },
    status,
    conclusion,
    htmlUrl: `https://github.com/demo/repo/actions/runs/1`,
    startedAt: "2024-01-01T00:00:00Z",
    completedAt: status === "completed" ? "2024-01-01T01:00:00Z" : null,
  };
}

function makeReview(state: GitHubReview["state"]): GitHubReview {
  return {
    id: 1001,
    user: "reviewer-bob",
    state,
    submittedAt: "2024-01-01T12:00:00Z",
    commitId: "abc123def456abc123def456abc123def456abc1",
  };
}

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    pr: makePR(),
    files: [makeFile("src/index.ts")],
    checkRuns: [makeCheck("CI / build", "success")],
    reviews: [makeReview("APPROVED")],
    ...overrides,
  };
}

function makeCriterion(
  id: string,
  kind: AcceptanceCriterion["kind"],
  checkType?: AcceptanceCriterion["checkType"],
  extras: Partial<AcceptanceCriterion> = {}
): AcceptanceCriterion {
  return { id, description: id, kind, checkType, ...extras };
}

// ---------------------------------------------------------------------------
// Flag detection tests
// ---------------------------------------------------------------------------

describe("detectFlags", () => {
  it("clean PR — no flags", () => {
    const ctx = makeCtx({ files: [makeFile("src/feature.ts")] });
    expect(detectFlags(ctx)).toEqual([]);
  });

  it("WORKFLOW_FILE_MODIFIED — .github/workflows file changed", () => {
    const ctx = makeCtx({
      files: [makeFile(".github/workflows/ci.yml", "modified")],
    });
    expect(detectFlags(ctx)).toContain("WORKFLOW_FILE_MODIFIED");
  });

  it("WORKFLOW_FILE_MODIFIED — .github/workflows file added (could rig CI)", () => {
    const ctx = makeCtx({
      files: [makeFile(".github/workflows/evil.yml", "added")],
    });
    expect(detectFlags(ctx)).toContain("WORKFLOW_FILE_MODIFIED");
  });

  it("TEST_FILE_DELETED — .test.ts file removed", () => {
    const ctx = makeCtx({
      files: [makeFile("src/feature.test.ts", "removed")],
    });
    expect(detectFlags(ctx)).toContain("TEST_FILE_DELETED");
  });

  it("TEST_FILE_DELETED — .spec.js file removed", () => {
    const ctx = makeCtx({
      files: [makeFile("tests/feature.spec.js", "removed")],
    });
    expect(detectFlags(ctx)).toContain("TEST_FILE_DELETED");
  });

  it("TEST_FILE_DELETED — __tests__ file removed", () => {
    const ctx = makeCtx({
      files: [makeFile("src/__tests__/feature.test.ts", "removed")],
    });
    expect(detectFlags(ctx)).toContain("TEST_FILE_DELETED");
  });

  it("test file MODIFIED (not deleted) — no flag", () => {
    const ctx = makeCtx({
      files: [makeFile("src/feature.test.ts", "modified")],
    });
    // Deleting is rigging; modifying is OK (may be updating tests)
    expect(detectFlags(ctx)).not.toContain("TEST_FILE_DELETED");
  });

  it("DRAFT_PR — PR is a draft", () => {
    const ctx = makeCtx({ pr: makePR({ draft: true }) });
    expect(detectFlags(ctx)).toContain("DRAFT_PR");
  });

  it("WRONG_AUTHOR — PR author doesn't match expected", () => {
    const ctx = makeCtx({ pr: makePR({ author: "attacker" }) });
    ctx; // reassign for expectedAuthor
    const ctxWithAuthor = { ...ctx, expectedAuthor: "freelancer-alice" };
    expect(detectFlags(ctxWithAuthor)).toContain("WRONG_AUTHOR");
  });

  it("correct author — no WRONG_AUTHOR flag", () => {
    const ctx = makeCtx({
      pr: makePR({ author: "freelancer-alice" }),
    });
    const ctxWithAuthor = { ...ctx, expectedAuthor: "freelancer-alice" };
    expect(detectFlags(ctxWithAuthor)).not.toContain("WRONG_AUTHOR");
  });

  it("no expectedAuthor set — no WRONG_AUTHOR flag", () => {
    const ctx = makeCtx({ pr: makePR({ author: "anyone" }) });
    expect(detectFlags(ctx)).not.toContain("WRONG_AUTHOR");
  });

  it("multiple flags — all raised", () => {
    const ctx = makeCtx({
      pr: makePR({ draft: true }),
      files: [makeFile(".github/workflows/ci.yml", "modified")],
    });
    const flags = detectFlags(ctx);
    expect(flags).toContain("WORKFLOW_FILE_MODIFIED");
    expect(flags).toContain("DRAFT_PR");
  });
});

// ---------------------------------------------------------------------------
// verifyObjectiveCriteria tests
// ---------------------------------------------------------------------------

describe("verifyObjectiveCriteria", () => {
  describe("ci_passes", () => {
    it("all checks success → met=true", () => {
      const ctx = makeCtx({
        checkRuns: [makeCheck("CI / build", "success"), makeCheck("CI / test", "success")],
      });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("ci_passes", "objective", "ci_passes")],
        ctx
      );
      expect(result.met).toBe(true);
    });

    it("one check failed → met=false", () => {
      const ctx = makeCtx({
        checkRuns: [makeCheck("CI / build", "success"), makeCheck("CI / test", "failure")],
      });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("ci_passes", "objective", "ci_passes")],
        ctx
      );
      expect(result.met).toBe(false);
    });

    it("checks still running → met=null", () => {
      const ctx = makeCtx({
        checkRuns: [makeCheck("CI / build", null, "in_progress")],
      });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("ci_passes", "objective", "ci_passes")],
        ctx
      );
      expect(result.met).toBeNull();
    });

    it("no check runs → met=null", () => {
      const ctx = makeCtx({ checkRuns: [] });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("ci_passes", "objective", "ci_passes")],
        ctx
      );
      expect(result.met).toBeNull();
    });

    it("allowlist filters to relevant checks only — irrelevant failed checks ignored", () => {
      const ctx = makeCtx({
        checkRuns: [
          makeCheck("CI / build", "success"),
          makeCheck("security-scan", "failure"), // not in allowlist
        ],
      });
      const [result] = verifyObjectiveCriteria(
        [
          makeCriterion("ci_passes", "objective", "ci_passes", {
            ciWorkflowAllowlist: ["CI / build"],
          }),
        ],
        ctx
      );
      expect(result.met).toBe(true);
    });
  });

  describe("pr_merged", () => {
    it("merged PR → met=true", () => {
      const ctx = makeCtx({ pr: makePR({ merged: true }) });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("pr_merged", "objective", "pr_merged")],
        ctx
      );
      expect(result.met).toBe(true);
    });

    it("open PR → met=false", () => {
      const ctx = makeCtx({ pr: makePR({ merged: false, state: "open" }) });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("pr_merged", "objective", "pr_merged")],
        ctx
      );
      expect(result.met).toBe(false);
    });
  });

  describe("required_review_approved", () => {
    it("APPROVED review → met=true", () => {
      const ctx = makeCtx({ reviews: [makeReview("APPROVED")] });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("review", "objective", "required_review_approved")],
        ctx
      );
      expect(result.met).toBe(true);
    });

    it("no reviews → met=false", () => {
      const ctx = makeCtx({ reviews: [] });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("review", "objective", "required_review_approved")],
        ctx
      );
      expect(result.met).toBe(false);
    });

    it("CHANGES_REQUESTED only → met=false", () => {
      const ctx = makeCtx({ reviews: [makeReview("CHANGES_REQUESTED")] });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("review", "objective", "required_review_approved")],
        ctx
      );
      expect(result.met).toBe(false);
    });
  });

  describe("files_present", () => {
    it("required file in changed list → met=true", () => {
      const ctx = makeCtx({ files: [makeFile("src/feature.ts")] });
      const [result] = verifyObjectiveCriteria(
        [
          makeCriterion("files", "objective", "files_present", {
            requiredFiles: ["src/feature.ts"],
          }),
        ],
        ctx
      );
      expect(result.met).toBe(true);
    });

    it("required file missing → met=false", () => {
      const ctx = makeCtx({ files: [makeFile("src/other.ts")] });
      const [result] = verifyObjectiveCriteria(
        [
          makeCriterion("files", "objective", "files_present", {
            requiredFiles: ["src/missing.ts"],
          }),
        ],
        ctx
      );
      expect(result.met).toBe(false);
    });

    it("no required files specified → met=true (vacuous)", () => {
      const ctx = makeCtx({ files: [] });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("files", "objective", "files_present", { requiredFiles: [] })],
        ctx
      );
      expect(result.met).toBe(true);
    });
  });

  describe("no_workflow_or_test_tampering", () => {
    it("clean PR → met=true", () => {
      const ctx = makeCtx({ files: [makeFile("src/feature.ts")] });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("no_tampering", "objective", "no_workflow_or_test_tampering")],
        ctx
      );
      expect(result.met).toBe(true);
    });

    it("workflow file modified → met=false", () => {
      const ctx = makeCtx({
        files: [makeFile(".github/workflows/ci.yml", "modified")],
      });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("no_tampering", "objective", "no_workflow_or_test_tampering")],
        ctx
      );
      expect(result.met).toBe(false);
    });

    it("test file deleted → met=false", () => {
      const ctx = makeCtx({
        files: [makeFile("src/feature.test.ts", "removed")],
      });
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("no_tampering", "objective", "no_workflow_or_test_tampering")],
        ctx
      );
      expect(result.met).toBe(false);
    });
  });

  describe("subjective criterion", () => {
    it("passes through with met=null regardless of PR state", () => {
      const ctx = makeCtx();
      const [result] = verifyObjectiveCriteria(
        [makeCriterion("code_quality", "subjective")],
        ctx
      );
      expect(result.kind).toBe("subjective");
      expect(result.met).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// validateEvidenceRefs tests
// ---------------------------------------------------------------------------

describe("validateEvidenceRefs", () => {
  it("valid check name ref — kept", () => {
    const ctx = makeCtx({
      checkRuns: [makeCheck("CI / build", "success")],
    });
    const { valid, dropped } = validateEvidenceRefs(["CI / build"], ctx);
    expect(valid).toContain("CI / build");
    expect(dropped).toHaveLength(0);
  });

  it("valid head SHA ref — kept", () => {
    const ctx = makeCtx({ pr: makePR({ headSha: "abc123def456abc123def456abc123def456abc1" }) });
    const { valid, dropped } = validateEvidenceRefs(
      ["abc123def456abc123def456abc123def456abc1"],
      ctx
    );
    expect(valid).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("fabricated reference — dropped", () => {
    const ctx = makeCtx();
    const { valid, dropped } = validateEvidenceRefs(
      ["totally-made-up-commit-zzzzzz"],
      ctx
    );
    expect(valid).toHaveLength(0);
    expect(dropped).toContain("totally-made-up-commit-zzzzzz");
  });

  it("fabricated file path — dropped", () => {
    const ctx = makeCtx({ files: [makeFile("src/real.ts")] });
    const { valid, dropped } = validateEvidenceRefs(["src/fake-file.ts"], ctx);
    expect(dropped).toContain("src/fake-file.ts");
  });

  it("valid file path — kept", () => {
    const ctx = makeCtx({ files: [makeFile("src/real.ts")] });
    const { valid, dropped } = validateEvidenceRefs(["src/real.ts"], ctx);
    expect(valid).toContain("src/real.ts");
    expect(dropped).toHaveLength(0);
  });

  it("mix of valid and fabricated — only valid kept", () => {
    const ctx = makeCtx({
      checkRuns: [makeCheck("CI / build", "success")],
    });
    const { valid, dropped } = validateEvidenceRefs(
      ["CI / build", "fake-check-xyz"],
      ctx
    );
    expect(valid).toContain("CI / build");
    expect(dropped).toContain("fake-check-xyz");
  });
});
