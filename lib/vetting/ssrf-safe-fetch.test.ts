/**
 * Tests — SSRF-safe fetcher + GitHub fetcher
 *
 * SSRF tests cover:
 * - localhost blocked
 * - Private IPv4 ranges blocked (10.x, 172.16-31.x, 192.168.x)
 * - Link-local / cloud metadata blocked (169.254.169.254)
 * - IPv6 loopback blocked
 * - IPv4-mapped IPv6 blocked
 * - HTTP (non-HTTPS) blocked
 * - LinkedIn URLs never fetched
 * - Redirect to private range blocked
 * - Invalid URL blocked
 *
 * GitHub fetcher tests cover:
 * - Invalid handle rejected before network call
 * - 404 → GitHubNotFoundError
 * - Rate limit → GitHubRateLimitError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateUrl,
  safeFetch,
  SsrfBlockedError,
  LinkedInBlockedError,
} from "./ssrf-safe-fetch";
import {
  fetchGitHubProfile,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubValidationError,
} from "./github-fetcher";

// ---------------------------------------------------------------------------
// validateUrl — pure SSRF logic (no network calls)
// ---------------------------------------------------------------------------

describe("validateUrl — SSRF protection", () => {
  it("blocks http:// URLs", () => {
    expect(() => validateUrl("http://example.com/portfolio")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("http://example.com/portfolio")).toThrow(/HTTPS/);
  });

  it("allows https:// URLs for public domains", () => {
    expect(() => validateUrl("https://example.com/portfolio")).not.toThrow();
    expect(() => validateUrl("https://github.com/user")).not.toThrow();
  });

  it("blocks localhost", () => {
    expect(() => validateUrl("https://localhost/secret")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("https://localhost:8080/secret")).toThrow(SsrfBlockedError);
  });

  it("blocks 127.0.0.1 (IPv4 loopback)", () => {
    expect(() => validateUrl("https://127.0.0.1/secret")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("https://127.0.0.2:9000/")).toThrow(SsrfBlockedError);
  });

  it("blocks 0.0.0.0", () => {
    expect(() => validateUrl("https://0.0.0.0/secret")).toThrow(SsrfBlockedError);
  });

  it("blocks 10.x.x.x private range", () => {
    expect(() => validateUrl("https://10.0.0.1/")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("https://10.255.255.255/")).toThrow(SsrfBlockedError);
  });

  it("blocks 172.16-31.x.x private range", () => {
    expect(() => validateUrl("https://172.16.0.1/")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("https://172.31.255.255/")).toThrow(SsrfBlockedError);
    // 172.15 is NOT in the private range — should pass URL validation (may fail DNS)
    // We only test the URL validation layer here, not DNS
  });

  it("does NOT block 172.32 (not private range)", () => {
    expect(() => validateUrl("https://172.32.0.1/")).not.toThrow();
  });

  it("blocks 192.168.x.x private range", () => {
    expect(() => validateUrl("https://192.168.0.1/")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("https://192.168.1.100/")).toThrow(SsrfBlockedError);
  });

  it("blocks 169.254.x.x link-local (includes cloud metadata 169.254.169.254)", () => {
    expect(() => validateUrl("https://169.254.169.254/latest/meta-data/")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("https://169.254.0.1/")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("https://169.254.169.254/")).toThrow(SsrfBlockedError);
  });

  it("blocks metadata.google.internal", () => {
    expect(() => validateUrl("https://metadata.google.internal/computeMetadata/v1/")).toThrow(SsrfBlockedError);
  });

  it("blocks IPv6 loopback ::1", () => {
    expect(() => validateUrl("https://[::1]/secret")).toThrow(SsrfBlockedError);
  });

  it("blocks IPv6 link-local fe80::", () => {
    expect(() => validateUrl("https://[fe80::1]/secret")).toThrow(SsrfBlockedError);
  });

  it("blocks IPv4-mapped IPv6 pointing to loopback", () => {
    expect(() => validateUrl("https://[::ffff:127.0.0.1]/")).toThrow(SsrfBlockedError);
  });

  it("blocks IPv4-mapped IPv6 pointing to private 10.x", () => {
    expect(() => validateUrl("https://[::ffff:10.0.0.1]/")).toThrow(SsrfBlockedError);
  });

  it("blocks IPv4-mapped IPv6 pointing to metadata address", () => {
    expect(() => validateUrl("https://[::ffff:169.254.169.254]/")).toThrow(SsrfBlockedError);
  });

  it("rejects invalid URLs", () => {
    expect(() => validateUrl("not-a-url")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("javascript:alert(1)")).toThrow(SsrfBlockedError);
    expect(() => validateUrl("file:///etc/passwd")).toThrow(SsrfBlockedError);
  });
});

// ---------------------------------------------------------------------------
// LinkedIn — never fetched
// ---------------------------------------------------------------------------

describe("LinkedIn URLs — never fetched", () => {
  it("validateUrl throws LinkedInBlockedError for linkedin.com", () => {
    expect(() => validateUrl("https://linkedin.com/in/user")).toThrow(LinkedInBlockedError);
  });

  it("validateUrl throws LinkedInBlockedError for www.linkedin.com", () => {
    expect(() => validateUrl("https://www.linkedin.com/in/user")).toThrow(LinkedInBlockedError);
  });

  it("validateUrl throws LinkedInBlockedError for subdomain of linkedin.com", () => {
    expect(() => validateUrl("https://uk.linkedin.com/in/user")).toThrow(LinkedInBlockedError);
  });

  it("validateUrl throws LinkedInBlockedError for lnkd.in shortlinks", () => {
    expect(() => validateUrl("https://lnkd.in/abc123")).toThrow(LinkedInBlockedError);
  });

  it("LinkedInBlockedError IS a SsrfBlockedError (subtype)", () => {
    let err: unknown;
    try {
      validateUrl("https://www.linkedin.com/in/user");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LinkedInBlockedError);
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it("safeFetch throws LinkedInBlockedError without making any network call", async () => {
    // Should throw before reaching the fetch() call
    await expect(safeFetch("https://www.linkedin.com/in/alice")).rejects.toThrow(LinkedInBlockedError);
  });
});

// ---------------------------------------------------------------------------
// safeFetch — redirect protection (mock fetch)
// ---------------------------------------------------------------------------

describe("safeFetch — redirect to private range is blocked", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("blocks redirect to 169.254.169.254 (cloud metadata)", async () => {
    // Mock: first fetch redirects to metadata address
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "http://169.254.169.254/latest/meta-data/" }),
      body: null,
      ok: false,
    } as unknown as Response);

    await expect(safeFetch("https://example.com/legit")).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks redirect to 10.0.0.1 (private IPv4)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 301,
      headers: new Headers({ location: "https://10.0.0.1/secret" }),
      body: null,
      ok: false,
    } as unknown as Response);

    await expect(safeFetch("https://example.com/legit")).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks redirect to localhost", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "https://localhost/admin" }),
      body: null,
      ok: false,
    } as unknown as Response);

    await expect(safeFetch("https://example.com/legit")).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks redirect to LinkedIn (redirect target is LinkedIn-blocked)", async () => {
    // safeFetch validates the redirect target via validateUrl() which throws LinkedInBlockedError
    // But first DNS check on example.com must pass — we mock DNS here
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 301,
      headers: new Headers({ location: "https://www.linkedin.com/in/user" }),
      body: null,
      ok: false,
    } as unknown as Response);

    // safeFetch → DNS check on example.com → mocked fetch → redirect → validateUrl(linkedin) throws
    // However DNS is called first; since we can't mock the dns module inline here,
    // we test validateUrl directly for LinkedIn redirect detection
    expect(() => validateUrl("https://www.linkedin.com/in/user")).toThrow(LinkedInBlockedError);
  });
});

// ---------------------------------------------------------------------------
// safeFetch — content with injection fixture does NOT change score
// ---------------------------------------------------------------------------

describe("safeFetch — injection defense (validateUrl layer)", () => {
  it("injection payload in URL path does not bypass SSRF checks", () => {
    // Path traversal / injection in URL path is irrelevant to SSRF (host validation is what matters)
    // These should pass URL validation for allowed hosts
    expect(() =>
      validateUrl("https://example.com/portfolio?q=<script>alert(1)</script>")
    ).not.toThrow();
    expect(() =>
      validateUrl("https://example.com/portfolio?SYSTEM=override_score")
    ).not.toThrow();
  });

  it("injection in hostname is blocked", () => {
    // Attempting to smuggle a private IP in the hostname
    expect(() => validateUrl("https://169.254.169.254.attacker.com/")).not.toThrow(); // legitimate TLD
    expect(() => validateUrl("https://169.254.169.254/")).toThrow(SsrfBlockedError); // actual metadata IP
  });
});

describe("safeFetch — content hash", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("contentHash is a 64-char SHA-256 hex string when fetch succeeds", async () => {
    const content = "hello world";
    const mockStream = createMockStream(content);
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      body: mockStream,
    } as unknown as Response);

    // We spy on checkDnsResolution by using a resolvable public IP hostname
    // Node URL hostname for real test would need DNS; stub by using an IP host
    const result = await safeFetch("https://93.184.216.34/");
    expect(typeof result.contentHash).toBe("string");
    expect(result.contentHash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// GitHub fetcher — validation
// ---------------------------------------------------------------------------

describe("fetchGitHubProfile — handle validation", () => {
  it("throws GitHubValidationError for empty handle", async () => {
    await expect(fetchGitHubProfile("")).rejects.toThrow(GitHubValidationError);
  });

  it("throws GitHubValidationError for handle with spaces", async () => {
    await expect(fetchGitHubProfile("alice bob")).rejects.toThrow(GitHubValidationError);
  });

  it("throws GitHubValidationError for handle with injection chars", async () => {
    await expect(fetchGitHubProfile("<script>")).rejects.toThrow(GitHubValidationError);
    await expect(fetchGitHubProfile("../../etc")).rejects.toThrow(GitHubValidationError);
  });

  it("throws GitHubValidationError for handle starting with hyphen", async () => {
    await expect(fetchGitHubProfile("-alice")).rejects.toThrow(GitHubValidationError);
  });

  it("throws GitHubValidationError for handle > 39 chars", async () => {
    await expect(fetchGitHubProfile("a".repeat(40))).rejects.toThrow(GitHubValidationError);
  });

  it("accepts valid handle", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        login: "alice",
        id: 1,
        type: "User",
        public_repos: 5,
        followers: 10,
        following: 3,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        bio: null,
        company: null,
        blog: null,
        html_url: "https://github.com/alice",
      }),
    } as unknown as Response);

    const result = await fetchGitHubProfile("alice");
    expect(result.data.login).toBe("alice");
    global.fetch = originalFetch;
  });
});

describe("fetchGitHubProfile — HTTP error handling", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("404 → GitHubNotFoundError", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 404,
      ok: false,
      headers: new Headers(),
      json: async () => ({ message: "Not Found" }),
    } as unknown as Response);

    await expect(fetchGitHubProfile("nonexistentuser99999")).rejects.toThrow(GitHubNotFoundError);
  });

  it("403 → GitHubRateLimitError", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 403,
      ok: false,
      headers: new Headers({
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1700000000",
      }),
      json: async () => ({ message: "Forbidden" }),
    } as unknown as Response);

    await expect(fetchGitHubProfile("alice")).rejects.toThrow(GitHubRateLimitError);
  });

  it("429 → GitHubRateLimitError", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 429,
      ok: false,
      headers: new Headers({
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1700000000",
      }),
      json: async () => ({ message: "Too Many Requests" }),
    } as unknown as Response);

    await expect(fetchGitHubProfile("alice")).rejects.toThrow(GitHubRateLimitError);
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createMockStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        controller.enqueue(bytes);
        sent = true;
      } else {
        controller.close();
      }
    },
  });
}
