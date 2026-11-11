/**
 * Tests — vetting run diagnostics (parse + card banner copy).
 *
 * Pure unit tests: no database, no network, no LLM.
 *
 * Invariants tested:
 * 1. parseVettingDiagnostics never throws and rejects malformed payloads
 * 2. A fallback run always yields an error banner (scores are 0 by definition)
 * 3. Zero signals with errors yields an error banner naming the cause
 * 4. Zero signals without errors yields an honest "not inferred" info banner
 * 5. Signals + errors yields a partial-success warning
 * 6. Clean runs yield no banner
 */

import { describe, it, expect } from "vitest";
import {
  describeVettingDiagnostics,
  parseVettingDiagnostics,
  type VettingDiagnostics,
} from "./diagnostics";

function makeDiagnostics(
  overrides: Partial<VettingDiagnostics> = {}
): VettingDiagnostics {
  return {
    ranAt: "2026-11-09T12:00:00Z",
    signalCount: 0,
    usedFallback: false,
    fabricatedDropped: 0,
    reposAnalyzed: [],
    errors: [],
    ...overrides,
  };
}

describe("parseVettingDiagnostics", () => {
  it("parses a well-formed payload", () => {
    const parsed = parseVettingDiagnostics(
      makeDiagnostics({ signalCount: 3, reposAnalyzed: ["a/b"] })
    );
    expect(parsed?.signalCount).toBe(3);
    expect(parsed?.reposAnalyzed).toEqual(["a/b"]);
  });

  it("returns null for null/undefined/primitives", () => {
    expect(parseVettingDiagnostics(null)).toBeNull();
    expect(parseVettingDiagnostics(undefined)).toBeNull();
    expect(parseVettingDiagnostics("nope")).toBeNull();
    expect(parseVettingDiagnostics(42)).toBeNull();
  });

  it("returns null when required fields are missing or mistyped", () => {
    expect(parseVettingDiagnostics({})).toBeNull();
    expect(
      parseVettingDiagnostics({ ...makeDiagnostics(), signalCount: "3" })
    ).toBeNull();
    expect(
      parseVettingDiagnostics({ ...makeDiagnostics(), errors: "oops" })
    ).toBeNull();
  });

  it("drops non-string entries from arrays instead of throwing", () => {
    const parsed = parseVettingDiagnostics({
      ...makeDiagnostics(),
      reposAnalyzed: ["a/b", 42, null],
      errors: ["boom", { x: 1 }],
    });
    expect(parsed?.reposAnalyzed).toEqual(["a/b"]);
    expect(parsed?.errors).toEqual(["boom"]);
  });
});

describe("describeVettingDiagnostics", () => {
  it("returns null when diagnostics are absent or the run never happened", () => {
    expect(describeVettingDiagnostics(null, 0)).toBeNull();
    expect(
      describeVettingDiagnostics(makeDiagnostics({ ranAt: "" }), 0)
    ).toBeNull();
  });

  it("fallback run → error banner (score is 0 by definition)", () => {
    const banner = describeVettingDiagnostics(
      makeDiagnostics({
        usedFallback: true,
        errors: ["GROQ_API_KEY not set — deterministic fallback"],
      }),
      0
    );
    expect(banner?.tone).toBe("error");
    expect(banner?.title).toContain("incomplete");
    expect(banner?.detail).toContain("GROQ_API_KEY");
  });

  it("zero signals with errors → error banner naming the cause", () => {
    const banner = describeVettingDiagnostics(
      makeDiagnostics({
        errors: ["GitHub fetch failed: rate limit exceeded"],
        reposAnalyzed: [],
      }),
      0
    );
    expect(banner?.tone).toBe("error");
    expect(banner?.detail).toContain("rate limit");
  });

  it("zero signals without errors → honest 'not inferred' info banner", () => {
    const banner = describeVettingDiagnostics(
      makeDiagnostics({
        reposAnalyzed: ["leerob/some-repo", "leerob/other-repo"],
      }),
      0
    );
    expect(banner?.tone).toBe("info");
    expect(banner?.title).toContain("not inferred");
    expect(banner?.detail).toContain("honestly 0");
    expect(banner?.detail).toContain("leerob/some-repo");
  });

  it("zero signals mention rejected excerpts when verification dropped them", () => {
    const banner = describeVettingDiagnostics(
      makeDiagnostics({ fabricatedDropped: 2 }),
      0
    );
    expect(banner?.tone).toBe("info");
    expect(banner?.detail).toContain("2 candidate excerpts were rejected");
  });

  it("signals + errors → partial-success warning", () => {
    const banner = describeVettingDiagnostics(
      makeDiagnostics({
        signalCount: 4,
        errors: ["GitHub repo detail fetch failed for x/y: timeout"],
      }),
      0.62
    );
    expect(banner?.tone).toBe("warn");
    expect(banner?.title).toContain("Partial");
  });

  it("clean run → no banner", () => {
    expect(
      describeVettingDiagnostics(makeDiagnostics({ signalCount: 5 }), 0.8)
    ).toBeNull();
  });
});
