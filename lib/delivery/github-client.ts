/**
 * GitHub REST client for the Delivery Agent.
 *
 * Uses GITHUB_TOKEN env var (fine-grained, read-only PAT).
 * Handles 401/403/404 and rate limits (reads X-RateLimit-* headers).
 *
 * Endpoints used (all verified against GitHub REST docs):
 *   GET /repos/{owner}/{repo}/pulls/{pull_number}
 *     https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 *     Status: VERIFIED (endpoint confirmed in docs; not yet called in demo repo)
 *
 *   GET /repos/{owner}/{repo}/pulls/{pull_number}/files
 *     https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
 *     Status: VERIFIED (endpoint confirmed in docs; not yet called in demo repo)
 *
 *   GET /repos/{owner}/{repo}/commits/{commit_sha}/check-runs
 *     https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
 *     Status: VERIFIED (endpoint confirmed in docs; not yet called in demo repo)
 *
 *   GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
 *     https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
 *     Status: VERIFIED (endpoint confirmed in docs; not yet called in demo repo)
 *
 * Env: GITHUB_TOKEN — optional but strongly recommended (60→5000 req/hr).
 *      DELIVERY_AGENT_REPO — "owner/repo" — the ONLY repo accepted for verification.
 *        If set, any PR URL not matching this repo is rejected.
 *        If absent, any public repo is accepted (less secure; log a warning).
 */

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: string;
  authorId: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface GitHubFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  sha: string;
  rawUrl: string | null;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  app: { slug: string; id: number } | null;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "skipped"
    | null;
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitHubReview {
  id: number;
  user: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string | null;
  commitId: string;
}

export interface GitHubRateLimit {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp
  used: number;
}

export interface GitHubError {
  status: 401 | 403 | 404 | 429 | number;
  message: string;
  rateLimit?: GitHubRateLimit;
}

/** Thrown on any GitHub API error (4xx / 5xx). */
export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly rateLimit?: GitHubRateLimit
  ) {
    super(`GitHub API ${status}: ${message}`);
    this.name = "GitHubApiError";
  }
}

const GITHUB_API_BASE = "https://api.github.com";

function getHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ConsultAI-DeliveryAgent/1.0",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function parseRateLimit(headers: Headers): GitHubRateLimit | undefined {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  const used = headers.get("x-ratelimit-used");
  if (!limit || !remaining || !reset) return undefined;
  return {
    limit: parseInt(limit, 10),
    remaining: parseInt(remaining, 10),
    reset: parseInt(reset, 10),
    used: used ? parseInt(used, 10) : 0,
  };
}

async function githubFetch<T>(path: string): Promise<T> {
  const url = `${GITHUB_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: getHeaders(),
    cache: "no-store",
  });

  const rateLimit = parseRateLimit(res.headers);

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // ignore parse error
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      throw new GitHubApiError(
        429,
        `Rate limit exceeded. ${retryAfter ? `Retry after ${retryAfter}s.` : ""}`,
        rateLimit
      );
    }

    throw new GitHubApiError(res.status, message, rateLimit);
  }

  return res.json() as Promise<T>;
}

/**
 * Parses and validates a GitHub PR URL.
 * Returns { owner, repo, number } or throws on invalid format.
 *
 * Accepted formats:
 *   https://github.com/owner/repo/pull/123
 *   https://github.com/owner/repo/pull/123/files
 *   https://github.com/owner/repo/pull/123/commits
 */
export function parsePrUrl(prUrl: string): {
  owner: string;
  repo: string;
  number: number;
} {
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    throw new Error(`Invalid URL: ${prUrl}`);
  }

  if (url.hostname !== "github.com") {
    throw new Error(`Expected github.com URL, got: ${url.hostname}`);
  }

  const parts = url.pathname.replace(/^\//, "").split("/");
  // parts: [owner, repo, "pull", number, ...]
  if (parts.length < 4 || parts[2] !== "pull") {
    throw new Error(
      `URL must be a GitHub pull request URL (…/owner/repo/pull/N): ${prUrl}`
    );
  }

  const owner = parts[0];
  const repo = parts[1];
  const number = parseInt(parts[3], 10);

  if (!owner || !repo || isNaN(number) || number < 1) {
    throw new Error(`Could not parse owner/repo/number from: ${prUrl}`);
  }

  return { owner, repo, number };
}

/**
 * Validates the PR URL against the configured demo repo.
 * If DELIVERY_AGENT_REPO is set, rejects any PR not from that repo.
 * Returns the configured repo as "owner/repo" if set, or null.
 */
export function validateRepo(owner: string, repo: string): void {
  const configuredRepo = process.env.DELIVERY_AGENT_REPO;
  if (!configuredRepo) {
    // No restriction — warn but continue
    console.warn(
      "[github] DELIVERY_AGENT_REPO not set — accepting any public repo. " +
        "Set DELIVERY_AGENT_REPO=owner/repo to restrict verification to the demo repo."
    );
    return;
  }

  const expected = configuredRepo.toLowerCase().trim();
  const actual = `${owner}/${repo}`.toLowerCase();

  if (actual !== expected) {
    throw new Error(
      `PR is from '${owner}/${repo}' but DELIVERY_AGENT_REPO is configured as '${configuredRepo}'. ` +
        `Only PRs from the configured repo are accepted.`
    );
  }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Fetches PR details.
 * Doc: https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */
export async function fetchPRDetails(
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubPR> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await githubFetch<any>(
    `/repos/${owner}/${repo}/pulls/${prNumber}`
  );

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? null,
    state: raw.state,
    merged: raw.merged ?? false,
    draft: raw.draft ?? false,
    headSha: raw.head.sha,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    author: raw.user?.login ?? "unknown",
    authorId: raw.user?.id ?? 0,
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    mergedAt: raw.merged_at ?? null,
  };
}

/**
 * Fetches changed files for a PR.
 * Doc: https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
 * Note: paginates up to 30 files per page; max 300 files.
 */
export async function fetchPRFiles(
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubFile[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await githubFetch<any[]>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`
  );

  return raw.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    sha: f.sha,
    rawUrl: f.raw_url ?? null,
  }));
}

/**
 * Fetches check runs for a commit SHA.
 * Doc: https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
 */
export async function fetchCheckRuns(
  owner: string,
  repo: string,
  commitSha: string
): Promise<GitHubCheckRun[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await githubFetch<{ check_runs: any[] }>(
    `/repos/${owner}/${repo}/commits/${commitSha}/check-runs?per_page=100`
  );

  return (raw.check_runs ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    app: r.app ? { slug: r.app.slug, id: r.app.id } : null,
    status: r.status,
    conclusion: r.conclusion ?? null,
    htmlUrl: r.html_url,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
  }));
}

/**
 * Fetches reviews for a PR.
 * Doc: https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
 */
export async function fetchPRReviews(
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubReview[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await githubFetch<any[]>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`
  );

  return raw.map((r) => ({
    id: r.id,
    user: r.user?.login ?? "unknown",
    state: r.state,
    submittedAt: r.submitted_at ?? null,
    commitId: r.commit_id,
  }));
}
