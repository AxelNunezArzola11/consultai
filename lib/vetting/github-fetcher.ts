/**
 * Vetting Agent — GitHub Fetcher
 *
 * Fetches public GitHub data for vetting candidates.
 * Uses GITHUB_TOKEN (optional; anonymous = 60 req/hr, authenticated = 5000 req/hr).
 *
 * Endpoints used (all public GitHub REST API):
 *   GET /users/{handle}
 *     https://docs.github.com/en/rest/users/users#get-a-user
 *   GET /users/{handle}/repos
 *     https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user
 *   GET /repos/{owner}/{repo}
 *     https://docs.github.com/en/rest/repos/repos#get-a-repository
 *   GET /repos/{owner}/{repo}/readme
 *     https://docs.github.com/en/rest/repos/contents#get-a-repository-readme
 *   GET /repos/{owner}/{repo}/languages
 *     https://docs.github.com/en/rest/repos/repos#list-repository-languages
 *
 * Security:
 * - Only fetches from api.github.com (hardcoded, not configurable).
 * - Only reads public data or data available with a read-only PAT.
 * - Rate limit headers are read and surfaced.
 * - LinkedIn URLs are NEVER fetched (enforced in the SSRF fetcher, asserted in tests).
 *
 * Cache:
 * - Responses include etag/last-modified. Cache by (url, content_hash) in signals table.
 */

const GITHUB_API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REPOS = 30; // limit to avoid burning rate limit

export interface GitHubUserProfile {
  login: string;
  id: number;
  type: "User" | "Organization";
  publicRepos: number;
  followers: number;
  following: number;
  createdAt: string;
  updatedAt: string;
  /** Bio text — may contain UNTRUSTED content; always treat as delimited */
  bio: string | null;
  company: string | null;
  blog: string | null;
  htmlUrl: string;
}

export interface GitHubRepoSummary {
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  stargazersCount: number;
  forksCount: number;
  topics: string[];
  isArchived: boolean;
  isFork: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  htmlUrl: string;
  defaultBranch: string;
}

export interface GitHubRepoDetail {
  summary: GitHubRepoSummary;
  /** README content (plain text, truncated to MAX_README_CHARS) — UNTRUSTED */
  readme: string | null;
  /** Language name → byte count */
  languages: Record<string, number>;
}

export interface GitHubRateLimit {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp
}

export interface GitHubFetchResult<T> {
  data: T;
  rateLimit: GitHubRateLimit | null;
  /** ETag for conditional requests */
  etag: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_README_CHARS = 3000;

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "consultai-vetting/1.0",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
  }
  return h;
}

function parseRateLimit(headers: Headers): GitHubRateLimit | null {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (!limit || !remaining || !reset) return null;
  return {
    limit: parseInt(limit, 10),
    remaining: parseInt(remaining, 10),
    reset: parseInt(reset, 10),
  };
}

async function githubGet<T>(
  path: string,
  signal?: AbortSignal
): Promise<GitHubFetchResult<T>> {
  const url = `${GITHUB_API}${path}`;
  const response = await fetch(url, {
    headers: githubHeaders(),
    signal,
  });

  if (response.status === 404) {
    throw new GitHubNotFoundError(`GitHub resource not found: ${path}`);
  }
  if (response.status === 403 || response.status === 429) {
    const rateLimit = parseRateLimit(response.headers);
    throw new GitHubRateLimitError(
      `GitHub rate limit exceeded. Resets at: ${rateLimit?.reset ?? "unknown"}`,
      rateLimit
    );
  }
  if (!response.ok) {
    throw new GitHubFetchError(`GitHub API error ${response.status}: ${path}`);
  }

  const data = (await response.json()) as T;
  const rateLimit = parseRateLimit(response.headers);
  const etag = response.headers.get("etag");

  return { data, rateLimit, etag };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchGitHubProfile(
  handle: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<GitHubFetchResult<GitHubUserProfile>> {
  validateGitHubHandle(handle);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const result = await githubGet<Record<string, unknown>>(`/users/${encodeURIComponent(handle)}`, ac.signal);
    const raw = result.data;
    return {
      ...result,
      data: {
        login: String(raw.login ?? ""),
        id: Number(raw.id ?? 0),
        type: (raw.type as "User" | "Organization") ?? "User",
        publicRepos: Number(raw.public_repos ?? 0),
        followers: Number(raw.followers ?? 0),
        following: Number(raw.following ?? 0),
        createdAt: String(raw.created_at ?? ""),
        updatedAt: String(raw.updated_at ?? ""),
        bio: raw.bio != null ? String(raw.bio) : null,
        company: raw.company != null ? String(raw.company) : null,
        blog: raw.blog != null ? String(raw.blog) : null,
        htmlUrl: String(raw.html_url ?? ""),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGitHubRepos(
  handle: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<GitHubFetchResult<GitHubRepoSummary[]>> {
  validateGitHubHandle(handle);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const result = await githubGet<Record<string, unknown>[]>(
      `/users/${encodeURIComponent(handle)}/repos?sort=updated&per_page=${MAX_REPOS}&type=owner`,
      ac.signal
    );
    return {
      ...result,
      data: result.data.map(mapRepo),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGitHubRepo(
  owner: string,
  repo: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<GitHubFetchResult<GitHubRepoDetail>> {
  validateGitHubHandle(owner);
  validateRepoName(repo);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const [repoResult, readmeResult, languagesResult] = await Promise.allSettled([
      githubGet<Record<string, unknown>>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        ac.signal
      ),
      githubGet<Record<string, unknown>>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
        ac.signal
      ),
      githubGet<Record<string, number>>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`,
        ac.signal
      ),
    ]);

    if (repoResult.status === "rejected") throw repoResult.reason;

    const summary = mapRepo(repoResult.value.data);
    const rateLimit = repoResult.value.rateLimit;
    const etag = repoResult.value.etag;

    let readme: string | null = null;
    if (readmeResult.status === "fulfilled") {
      const raw = readmeResult.value.data;
      if (raw.content && raw.encoding === "base64") {
        const decoded = Buffer.from(String(raw.content).replace(/\n/g, ""), "base64").toString("utf-8");
        readme = decoded.slice(0, MAX_README_CHARS);
      }
    }

    const languages: Record<string, number> =
      languagesResult.status === "fulfilled" ? languagesResult.value.data : {};

    return { data: { summary, readme, languages }, rateLimit, etag };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function mapRepo(raw: Record<string, unknown>): GitHubRepoSummary {
  return {
    name: String(raw.name ?? ""),
    fullName: String(raw.full_name ?? ""),
    description: raw.description != null ? String(raw.description) : null,
    language: raw.language != null ? String(raw.language) : null,
    stargazersCount: Number(raw.stargazers_count ?? 0),
    forksCount: Number(raw.forks_count ?? 0),
    topics: Array.isArray(raw.topics) ? raw.topics.map(String) : [],
    isArchived: Boolean(raw.archived ?? false),
    isFork: Boolean(raw.fork ?? false),
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    pushedAt: String(raw.pushed_at ?? ""),
    htmlUrl: String(raw.html_url ?? ""),
    defaultBranch: String(raw.default_branch ?? "main"),
  };
}

function validateGitHubHandle(handle: string): void {
  if (!handle || typeof handle !== "string") {
    throw new GitHubValidationError("GitHub handle must be a non-empty string");
  }
  // GitHub usernames: alphanumeric + hyphens, 1-39 chars, no leading/trailing hyphen
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(handle)) {
    throw new GitHubValidationError(`Invalid GitHub handle: "${handle}"`);
  }
}

function validateRepoName(repo: string): void {
  if (!repo || typeof repo !== "string") {
    throw new GitHubValidationError("Repo name must be a non-empty string");
  }
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(repo)) {
    throw new GitHubValidationError(`Invalid repo name: "${repo}"`);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitHubFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubFetchError";
  }
}

export class GitHubNotFoundError extends GitHubFetchError {
  constructor(message: string) {
    super(message);
    this.name = "GitHubNotFoundError";
  }
}

export class GitHubRateLimitError extends GitHubFetchError {
  rateLimit: GitHubRateLimit | null;
  constructor(message: string, rateLimit: GitHubRateLimit | null) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.rateLimit = rateLimit;
  }
}

export class GitHubValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubValidationError";
  }
}
