/**
 * Regression tests for vetting run feedback (lib/vetting/run-feedback.ts).
 *
 * A vetting run can succeed at HTTP level yet produce zero signals (e.g.
 * GitHub rate limit with no fallback engaged). Users must see WHY the score
 * is 0 instead of a bare "complete" toast.
 */

import { describe, it, expect } from "vitest";
import { vettingRunFeedback } from "./run-feedback";

describe("vettingRunFeedback", () => {
  it("no errors → ok (success UX unchanged)", () => {
    expect(vettingRunFeedback({ signalCount: 5, errors: [] })).toEqual({
      kind: "ok",
    });
    expect(vettingRunFeedback({})).toEqual({ kind: "ok" });
  });

  it("LLM fallback + errors → LLM-specific message (existing copy preserved)", () => {
    const fb = vettingRunFeedback({
      signalCount: 0,
      usedFallback: true,
      errors: ["Groq 503 overloaded"],
    });
    expect(fb.kind).toBe("empty");
    if (fb.kind === "empty") {
      expect(fb.message).toContain("LLM unavailable");
      expect(fb.message).toContain("Groq 503 overloaded");
    }
  });

  it("zero signals + errors without fallback → empty message with reason", () => {
    const fb = vettingRunFeedback({
      signalCount: 0,
      usedFallback: false,
      errors: ["GitHub fetch failed: GitHub rate limit exceeded."],
    });
    expect(fb.kind).toBe("empty");
    if (fb.kind === "empty") {
      expect(fb.message).toContain("no signals");
      expect(fb.message).toContain("GitHub rate limit exceeded");
    }
  });

  it("missing signalCount + errors → treated as empty", () => {
    const fb = vettingRunFeedback({ errors: ["boom"] });
    expect(fb.kind).toBe("empty");
  });

  it("partial success (signals + errors) → ok (existing success UX kept)", () => {
    expect(
      vettingRunFeedback({
        signalCount: 3,
        errors: ['LinkedIn URL stored as display-only link — not fetched'],
      })
    ).toEqual({ kind: "ok" });
  });

  it("blank error strings are ignored", () => {
    expect(vettingRunFeedback({ signalCount: 0, errors: ["", "  "] })).toEqual({
      kind: "ok",
    });
  });
});
