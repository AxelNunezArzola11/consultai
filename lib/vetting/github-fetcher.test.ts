/**
 * Tests — GitHub Fetcher (repo detail, config files, PR files)
 *
 * All network calls are mocked via vi.stubGlobal("fetch", ...).
 * No real API calls are made.
 *
 * Invariants tested:
 * 1. fetchGitHubRepo returns readme + languages + configFiles
 * 2. Config files that are absent (404) are silently skipped
 * 3. README content is base64-decoded and truncated
 * 4. Config file content is base64-decoded and truncated
 * 5. fetchGitHubPrFiles maps patch, additions, deletions correctly
 * 6. fetchGitHubPrFiles validates pull number (must be positive integer)
 * 7. Rate-limit error is surfaced
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  configFilesForLanguage,
  fetchGitHubRepo,
  fetchGitHubPrFiles,
  rankReposForVetting,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubValidationError,
  type GitHubRepoSummary,
} from "./github-fetcher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

/** Build a minimal fake GitHub API JSON response body with base64 content */
function makeContentResponse(text: string) {
  return JSON.stringify({
    content: base64(text),
    encoding: "base64",
  });
}

function makeRepoResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "my-repo",
    full_name: "user/my-repo",
    description: "A test repo",
    language: "TypeScript",
    stargazers_count: 42,
    forks_count: 5,
    topics: ["nextjs", "react"],
    archived: false,
    fork: false,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    pushed_at: "2024-06-01T00:00:00Z",
    html_url: "https://github.com/user/my-repo",
    default_branch: "main",
    ...overrides,
  });
}

function makeLanguagesResponse() {
  return JSON.stringify({ TypeScript: 50000, JavaScript: 10000 });
}

// ---------------------------------------------------------------------------
// fetchGitHubRepo — enriched content
// ---------------------------------------------------------------------------

describe("fetchGitHubRepo — enriched content", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns readme content decoded from base64", async () => {
    const readmeText = "# My Project\nThis is a Next.js app with TypeScript.";

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/readme")) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: new Headers(),
          json: () => Promise.resolve(JSON.parse(makeContentResponse(readmeText))),
        });
      }
      if (url.includes("/languages")) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({ TypeScript: 50000 }),
        });
      }
      if (url.includes("/contents/")) {
        // All config files → 404
        return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      // repo endpoint
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(JSON.parse(makeRepoResponse())),
      });
    }));

    const result = await fetchGitHubRepo("user", "my-repo");
    expect(result.data.readme).toContain("Next.js app with TypeScript");
    expect(result.data.summary.fullName).toBe("user/my-repo");
  });

  it("returns configFiles when package.json is present", async () => {
    const pkgJson = JSON.stringify({ name: "my-app", dependencies: { next: "14.0.0", react: "18.0.0" } });

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/readme")) {
        return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      if (url.includes("/languages")) {
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      if (url.includes("/contents/package.json")) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: new Headers(),
          json: () => Promise.resolve(JSON.parse(makeContentResponse(pkgJson))),
        });
      }
      if (url.includes("/contents/")) {
        return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(JSON.parse(makeRepoResponse())),
      });
    }));

    const result = await fetchGitHubRepo("user", "my-repo");
    expect(result.data.configFiles["package.json"]).toContain("next");
    expect(result.data.configFiles["package.json"]).toContain("react");
  });

  it("silently skips config files that return 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/readme") || url.includes("/contents/")) {
        return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      if (url.includes("/languages")) {
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(JSON.parse(makeRepoResponse())),
      });
    }));

    const result = await fetchGitHubRepo("user", "my-repo");
    expect(result.data.configFiles).toEqual({});
    expect(result.data.readme).toBeNull();
  });

  it("throws GitHubNotFoundError when repo itself returns 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 404, headers: new Headers(), json: () => Promise.resolve({}),
    }));

    await expect(fetchGitHubRepo("user", "nonexistent")).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  it("throws GitHubValidationError for invalid handle", async () => {
    await expect(fetchGitHubRepo("-bad-handle", "repo")).rejects.toBeInstanceOf(GitHubValidationError);
  });
});

// ---------------------------------------------------------------------------
// fetchGitHubPrFiles
// ---------------------------------------------------------------------------

describe("fetchGitHubPrFiles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns mapped file list with patch", async () => {
    const mockFiles = [
      {
        filename: "src/app/page.tsx",
        status: "modified",
        additions: 10,
        deletions: 3,
        patch: "@@ -1,3 +1,10 @@\n+import React from 'react';\n ...",
      },
      {
        filename: "package.json",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: null,
      },
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(mockFiles),
    }));

    const result = await fetchGitHubPrFiles("owner", "repo", 42);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].filename).toBe("src/app/page.tsx");
    expect(result.data[0].additions).toBe(10);
    expect(result.data[0].patch).toContain("import React");
    expect(result.data[1].patch).toBeNull();
  });

  it("throws GitHubValidationError for pull number < 1", async () => {
    await expect(fetchGitHubPrFiles("owner", "repo", 0)).rejects.toBeInstanceOf(GitHubValidationError);
  });

  it("throws GitHubValidationError for non-integer pull number", async () => {
    await expect(fetchGitHubPrFiles("owner", "repo", 1.5)).rejects.toBeInstanceOf(GitHubValidationError);
  });

  it("throws GitHubRateLimitError on 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 429,
      headers: new Headers({
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "9999999999",
      }),
      json: () => Promise.resolve({}),
    }));

    await expect(fetchGitHubPrFiles("owner", "repo", 1)).rejects.toBeInstanceOf(GitHubRateLimitError);
  });
});

// ---------------------------------------------------------------------------
// Content is properly truncated
// ---------------------------------------------------------------------------

describe("fetchGitHubRepo — truncation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("truncates README to MAX_README_CHARS (3000)", async () => {
    const longReadme = "A".repeat(10_000);

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/readme")) {
        return Promise.resolve({
          ok: true, status: 200, headers: new Headers(),
          json: () => Promise.resolve(JSON.parse(makeContentResponse(longReadme))),
        });
      }
      if (url.includes("/languages")) {
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      if (url.includes("/contents/")) {
        return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(JSON.parse(makeRepoResponse())),
      });
    }));

    const result = await fetchGitHubRepo("user", "my-repo");
    expect(result.data.readme!.length).toBeLessThanOrEqual(3000);
  });

  it("truncates config file content to MAX_CONFIG_FILE_CHARS (1500)", async () => {
    const bigPkg = JSON.stringify({ dependencies: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`pkg-${i}`, "1.0.0"])) });

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/readme") || (url.includes("/contents/") && !url.includes("package.json"))) {
        return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      if (url.includes("/languages")) {
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({}) });
      }
      if (url.includes("/contents/package.json")) {
        return Promise.resolve({
          ok: true, status: 200, headers: new Headers(),
          json: () => Promise.resolve(JSON.parse(makeContentResponse(bigPkg))),
        });
      }
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(JSON.parse(makeRepoResponse())),
      });
    }));

    const result = await fetchGitHubRepo("user", "my-repo");
    expect(result.data.configFiles["package.json"].length).toBeLessThanOrEqual(1500);
  });
});

// ---------------------------------------------------------------------------
// rankReposForVetting — prominence order, not recency order
// ---------------------------------------------------------------------------

describe("rankReposForVetting", () => {
  function repo(
    name: string,
    stars: number,
    forks = 0,
    pushedAt = "2024-01-01T00:00:00Z"
  ): GitHubRepoSummary {
    return {
      name,
      fullName: `user/${name}`,
      description: null,
      language: "TypeScript",
      stargazersCount: stars,
      forksCount: forks,
      topics: [],
      isArchived: false,
      isFork: false,
      createdAt: "2023-01-01T00:00:00Z",
      updatedAt: pushedAt,
      pushedAt,
      htmlUrl: `https://github.com/user/${name}`,
      defaultBranch: "main",
    };
  }

  it("ranks by stars desc so substantial work is analyzed first", () => {
    const repos = [
      repo("trivial-recent", 2, 0, "2026-11-01T00:00:00Z"),
      repo("flagship", 5000, 100, "2020-01-01T00:00:00Z"),
      repo("mid", 120, 5, "2023-01-01T00:00:00Z"),
    ];
    const ranked = rankReposForVetting(repos);
    expect(ranked.map((r) => r.name)).toEqual([
      "flagship",
      "mid",
      "trivial-recent",
    ]);
  });

  it("breaks star ties by forks, then by recency", () => {
    const repos = [
      repo("older", 10, 1, "2024-01-01T00:00:00Z"),
      repo("newer", 10, 1, "2025-01-01T00:00:00Z"),
      repo("forked", 10, 50, "2020-01-01T00:00:00Z"),
    ];
    const ranked = rankReposForVetting(repos);
    expect(ranked.map((r) => r.name)).toEqual([
      "forked",
      "newer",
      "older",
    ]);
  });

  it("returns at most 5 repos by default", () => {
    const repos = Array.from({ length: 12 }, (_, i) =>
      repo(`r${i}`, 100 - i)
    );
    expect(rankReposForVetting(repos)).toHaveLength(5);
    expect(rankReposForVetting(repos)[0].name).toBe("r0");
  });

  it("does not mutate the input array", () => {
    const repos = [repo("b", 1), repo("a", 99)];
    rankReposForVetting(repos);
    expect(repos.map((r) => r.name)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// configFilesForLanguage — quota-saving targeted fetching
// ---------------------------------------------------------------------------

describe("configFilesForLanguage", () => {
  it("fetches JS/TS dependency files for JavaScript/TypeScript repos", () => {
    expect(configFilesForLanguage("TypeScript")).toContain("package.json");
    expect(configFilesForLanguage("JavaScript")).toContain("package.json");
    expect(configFilesForLanguage("TypeScript")).not.toContain("Cargo.toml");
  });

  it("fetches Python manifests for Python repos", () => {
    expect(configFilesForLanguage("Python")).toEqual([
      "requirements.txt",
      "pyproject.toml",
    ]);
  });

  it("fetches single manifests for Rust/Go/PHP", () => {
    expect(configFilesForLanguage("Rust")).toEqual(["Cargo.toml"]);
    expect(configFilesForLanguage("Go")).toEqual(["go.mod"]);
    expect(configFilesForLanguage("PHP")).toEqual(["composer.json"]);
  });

  it("keeps the full candidate list for unknown languages (no silent drop)", () => {
    const all = configFilesForLanguage(null);
    expect(all).toContain("package.json");
    expect(all).toContain("Cargo.toml");
    expect(all.length).toBeGreaterThan(3);
    expect(configFilesForLanguage("Brainfuck")).toEqual(all);
  });
});
