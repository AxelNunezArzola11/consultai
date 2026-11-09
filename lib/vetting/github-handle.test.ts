import { describe, it, expect } from "vitest";
import {
  normalizeGithubHandle,
  normalizeCandidateSearchQuery,
  isValidGithubHandle,
} from "./github-handle";

describe("GitHub handle & candidate search normalization (Bug B)", () => {
  it("normalizes plain, @-prefixed, and full URL GitHub usernames to the same canonical handle", () => {
    expect(normalizeGithubHandle("AxelNunezArzola11")).toBe("axelnunezarzola11");
    expect(normalizeGithubHandle("@AxelNunezArzola11")).toBe("axelnunezarzola11");
    expect(normalizeGithubHandle("https://github.com/AxelNunezArzola11")).toBe(
      "axelnunezarzola11"
    );
    expect(normalizeGithubHandle("https://www.github.com/AxelNunezArzola11/repo")).toBe(
      "axelnunezarzola11"
    );
    expect(normalizeGithubHandle("github.com/AxelNunezArzola11/")).toBe(
      "axelnunezarzola11"
    );
  });

  it("normalizes candidate search queries while preserving multi-word names", () => {
    expect(normalizeCandidateSearchQuery("@AxelNunezArzola11")).toBe(
      "axelnunezarzola11"
    );
    expect(
      normalizeCandidateSearchQuery("https://github.com/AxelNunezArzola11")
    ).toBe("axelnunezarzola11");
    expect(normalizeCandidateSearchQuery("Jordan Kim")).toBe("Jordan Kim");
  });

  it("validates legal GitHub handles and rejects malformed ones", () => {
    expect(isValidGithubHandle("AxelNunezArzola11")).toBe(true);
    expect(isValidGithubHandle("@AxelNunezArzola11")).toBe(true);
    expect(isValidGithubHandle("-invalid")).toBe(false);
    expect(isValidGithubHandle("invalid-")).toBe(false);
    expect(isValidGithubHandle("")).toBe(false);
  });
});
