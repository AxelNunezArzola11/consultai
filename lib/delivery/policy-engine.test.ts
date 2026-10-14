/**
 * Policy engine unit tests
 *
 * Tests:
 * 1.  All objective criteria met, no flags, amount ≤ limit → AUTO_RELEASE_ELIGIBLE
 * 2.  Failing CI (objective criterion met=false) → REJECT_RECOMMENDED
 * 3.  Workflow file modified flag → REQUIRES_APPROVAL
 * 4.  Amount above limit → REQUIRES_APPROVAL
 * 5.  Subjective criterion present → REQUIRES_APPROVAL (never auto-release)
 * 6.  Head SHA mismatch → REQUIRES_APPROVAL
 * 7.  Multiple flags → REQUIRES_APPROVAL with all flags listed
 * 8.  Zero criteria (edge case) → AUTO_RELEASE_ELIGIBLE (no failures)
 * 9.  Null/unmet objective criterion → REQUIRES_APPROVAL
 * 10. Mixed: failing + subjective → REJECT_RECOMMENDED (hard fail wins)
 * 11. AUTO_RELEASE_LIMIT_USD = 0 (default) → amount 0.01 > 0 → REQUIRES_APPROVAL
 */

import { describe, it, expect } from "vitest";
import {
  evaluatePolicy,
  type PolicyInput,
  type CriterionResult,
} from "./policy-engine";

// Helpers
function makeInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    criteriaResults: [],
    flags: [],
    amountUsd: 100,
    autoReleaseLimitUsd: 500,
    shaMatches: true,
    ...overrides,
  };
}

function objective(id: string, met: boolean | null): CriterionResult {
  return { criterionId: id, kind: "objective", met, evidence: [] };
}

function subjective(id: string, met: boolean | null = null): CriterionResult {
  return { criterionId: id, kind: "subjective", met, evidence: [] };
}

describe("Policy engine", () => {
  describe("AUTO_RELEASE_ELIGIBLE", () => {
    it("all objective criteria met, no flags, amount ≤ limit, SHA matches", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [
            objective("ci_passes", true),
            objective("files_present", true),
          ],
          amountUsd: 100,
          autoReleaseLimitUsd: 500,
        })
      );
      expect(out.decision).toBe("AUTO_RELEASE_ELIGIBLE");
    });

    it("zero criteria, no flags, amount ≤ limit, SHA matches", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [],
          amountUsd: 0,
          autoReleaseLimitUsd: 500,
        })
      );
      expect(out.decision).toBe("AUTO_RELEASE_ELIGIBLE");
    });

    it("amount exactly equal to limit → eligible", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", true)],
          amountUsd: 500,
          autoReleaseLimitUsd: 500,
        })
      );
      expect(out.decision).toBe("AUTO_RELEASE_ELIGIBLE");
    });
  });

  describe("REJECT_RECOMMENDED", () => {
    it("failing CI — objective criterion met=false", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [
            objective("ci_passes", false),
            objective("files_present", true),
          ],
        })
      );
      expect(out.decision).toBe("REJECT_RECOMMENDED");
      expect(out.reasons.some((r) => r.includes("ci_passes"))).toBe(true);
    });

    it("multiple failing criteria — all cited in reasons", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [
            objective("ci_passes", false),
            objective("required_review_approved", false),
            objective("files_present", true),
          ],
        })
      );
      expect(out.decision).toBe("REJECT_RECOMMENDED");
      expect(out.reasons[0]).toContain("ci_passes");
      expect(out.reasons[0]).toContain("required_review_approved");
    });

    it("failing objective + subjective → hard fail wins, REJECT_RECOMMENDED", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [
            objective("ci_passes", false),
            subjective("code_quality", null),
          ],
        })
      );
      expect(out.decision).toBe("REJECT_RECOMMENDED");
    });
  });

  describe("REQUIRES_APPROVAL", () => {
    it("workflow file modified flag → REQUIRES_APPROVAL", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", true)],
          flags: ["WORKFLOW_FILE_MODIFIED"],
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
      expect(out.reasons.some((r) => r.includes("WORKFLOW_FILE_MODIFIED"))).toBe(true);
    });

    it("test file deleted flag → REQUIRES_APPROVAL", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", true)],
          flags: ["TEST_FILE_DELETED"],
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
    });

    it("multiple flags — all listed in reasons", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", true)],
          flags: ["WORKFLOW_FILE_MODIFIED", "DRAFT_PR", "WRONG_AUTHOR"],
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
      const reason = out.reasons.find((r) => r.includes("Flags raised"));
      expect(reason).toContain("WORKFLOW_FILE_MODIFIED");
      expect(reason).toContain("DRAFT_PR");
      expect(reason).toContain("WRONG_AUTHOR");
    });

    it("subjective criterion present → never auto-release", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [
            objective("ci_passes", true),
            subjective("code_quality"),
          ],
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
      expect(out.reasons.some((r) => r.includes("subjective"))).toBe(true);
    });

    it("subjective criterion met=true → still REQUIRES_APPROVAL (never auto)", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [subjective("code_quality", true)],
          flags: [],
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
    });

    it("amount above limit → REQUIRES_APPROVAL", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", true)],
          amountUsd: 501,
          autoReleaseLimitUsd: 500,
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
      expect(out.reasons.some((r) => r.includes("exceeds auto-release limit"))).toBe(true);
    });

    it("AUTO_RELEASE_LIMIT_USD = 0 (default) — any amount > 0 → REQUIRES_APPROVAL", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", true)],
          amountUsd: 0.01,
          autoReleaseLimitUsd: 0,
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
    });

    it("head SHA changed after verification → REQUIRES_APPROVAL", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", true)],
          shaMatches: false,
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
      expect(out.reasons.some((r) => r.includes("SHA changed"))).toBe(true);
    });

    it("null/unmet objective criterion → REQUIRES_APPROVAL", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [
            objective("ci_passes", true),
            objective("no_workflow_tampering", null),
          ],
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
      expect(out.reasons.some((r) => r.includes("unassessed"))).toBe(true);
    });

    it("draft PR flag → REQUIRES_APPROVAL", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", true)],
          flags: ["DRAFT_PR"],
        })
      );
      expect(out.decision).toBe("REQUIRES_APPROVAL");
    });
  });

  describe("decision priority", () => {
    it("REJECT_RECOMMENDED supersedes flags and amount concerns", () => {
      const out = evaluatePolicy(
        makeInput({
          criteriaResults: [objective("ci_passes", false)],
          flags: ["WORKFLOW_FILE_MODIFIED"],
          amountUsd: 10000,
          autoReleaseLimitUsd: 500,
        })
      );
      // Hard fail wins
      expect(out.decision).toBe("REJECT_RECOMMENDED");
    });
  });
});
