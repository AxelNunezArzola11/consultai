/**
 * GitHub handle normalization & validation utilities.
 *
 * Canonicalizes user input from any of:
 *   - "AxelNunezArzola11"
 *   - "@AxelNunezArzola11"
 *   - "https://github.com/AxelNunezArzola11"
 *   - "http://www.github.com/AxelNunezArzola11/repo"
 *   - "github.com/AxelNunezArzola11/"
 *
 * Returns the canonical lowercase GitHub username without a leading "@" or URL prefix.
 */

export function normalizeGithubHandle(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.trim();
  if (!s) return "";

  // Strip protocol + optional www. + github.com/
  const urlMatch = s.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)(?:[/?#].*)?$/i
  );
  if (urlMatch && urlMatch[1]) {
    s = urlMatch[1].trim();
  }

  // Strip leading @ symbols
  s = s.replace(/^@+/, "").trim();

  // Strip any trailing slashes
  s = s.replace(/\/+$/, "").trim();

  return s.toLowerCase();
}

/**
 * Normalizes a general candidate search query:
 * - If the query is a GitHub URL or starts with `@`, extracts the normalized handle.
 * - Otherwise returns the trimmed query string.
 */
export function normalizeCandidateSearchQuery(
  rawQuery: string | null | undefined
): string {
  if (!rawQuery) return "";
  const trimmed = rawQuery.trim();
  if (!trimmed) return "";

  if (
    trimmed.startsWith("@") ||
    /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(trimmed)
  ) {
    return normalizeGithubHandle(trimmed);
  }
  return trimmed;
}

/**
 * Validates that a handle or raw input conforms to GitHub username rules:
 * 1–39 alphanumeric characters or single hyphens, not starting/ending with a hyphen.
 */
export function isValidGithubHandle(handle: string): boolean {
  const normalized = normalizeGithubHandle(handle);
  if (!normalized) return false;
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(normalized);
}
