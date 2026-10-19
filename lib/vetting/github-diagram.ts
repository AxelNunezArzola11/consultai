/**
 * GitHub Portfolio Diagram
 *
 * Computes code-derived signals from already-fetched GitHub data and
 * produces a validated Mermaid quadrantChart string.
 *
 * Design rules (BOB_RULES rule 8):
 * - All signals computed in CODE from API data. LLM never touches this module.
 * - Every computed fact is linked to its source URL.
 * - No personal attributes (name used only as chart label, not a scoring feature).
 * - Labels are escaped before inserting into Mermaid syntax.
 * - Output is validated with a regex-parse guard before being returned.
 * - On any label escaping failure or parse guard failure: returns { ok: false, fallbackText }.
 *
 * Mermaid 12.2.0: quadrantChart confirmed present in installed source.
 * Source: node_modules/mermaid/dist/mermaid.js — keyword "quadrantChart" found.
 */

import type { GitHubRepoSummary } from "./github-fetcher";

// ---------------------------------------------------------------------------
// Computed signal types
// ---------------------------------------------------------------------------

export interface GitHubComputedSignals {
  /** GitHub handle for source URL construction */
  handle: string;
  /** Top 3 languages by byte count across all repos */
  topLanguages: string[];
  /** Count of repos updated in the last 90 days */
  recentActivity90d: number;
  /** Whether any repo has common test file patterns */
  hasTests: boolean;
  /** Whether any repo has CI config files */
  hasCi: boolean;
  /**
   * 0–1 score: fraction of project's tech stack languages present in candidate's repos.
   * Computed in code, never by LLM.
   */
  stackMatchScore: number;
  /** Source URLs for evidence (all github.com — never user-controlled redirect) */
  evidenceUrls: string[];
}

// Test file patterns (recognised by filename presence in repo topics/language data)
const TEST_PATTERNS = [
  "test", "spec", "jest", "vitest", "pytest", "rspec", "mocha", "jasmine",
  "__tests__", "cypress", "playwright",
];

// CI config patterns (common CI filenames in topics or repo metadata)
const CI_PATTERNS = [
  "github-actions", "ci", "travis", "circle-ci", "gitlab-ci",
  "jenkins", "drone", "actions", ".github",
];

// ---------------------------------------------------------------------------
// Signal computation
// ---------------------------------------------------------------------------

/**
 * Compute code-derived signals from fetched GitHub repos.
 * All inputs are from the GitHub REST API — no user-controlled content used
 * for scoring (only for display, clearly labelled UNTRUSTED where needed).
 */
export function computeGitHubSignals(
  handle: string,
  repos: GitHubRepoSummary[],
  projectTechStack: string[]
): GitHubComputedSignals {
  // Only count non-forked, non-archived repos
  const ownRepos = repos.filter((r) => !r.isFork && !r.isArchived);

  // Top languages by repo count (not byte count — we don't have bytes at this level)
  const langCount: Record<string, number> = {};
  for (const repo of ownRepos) {
    if (repo.language) {
      langCount[repo.language] = (langCount[repo.language] ?? 0) + 1;
    }
  }
  const topLanguages = Object.entries(langCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => lang);

  // Recent activity: repos with pushedAt within last 90 days
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recentActivity90d = ownRepos.filter((r) => {
    if (!r.pushedAt) return false;
    return new Date(r.pushedAt).getTime() > ninetyDaysAgo;
  }).length;

  // Has tests: any repo topic matches TEST_PATTERNS
  const allTopics = ownRepos.flatMap((r) => r.topics.map((t) => t.toLowerCase()));
  const hasTests = TEST_PATTERNS.some((p) => allTopics.some((t) => t.includes(p)));

  // Has CI: any repo topic matches CI_PATTERNS
  const hasCi = CI_PATTERNS.some((p) => allTopics.some((t) => t.includes(p)));

  // Stack match: fraction of project tech stack languages found in candidate languages
  const stackMatchScore = computeStackMatch(topLanguages, projectTechStack);

  // Evidence URLs (all github.com — not user-controlled)
  const evidenceUrls = [
    `https://github.com/${handle}`,
    ...ownRepos.slice(0, 3).map((r) => r.htmlUrl),
  ];

  return {
    handle,
    topLanguages,
    recentActivity90d,
    hasTests,
    hasCi,
    stackMatchScore,
    evidenceUrls,
  };
}

function computeStackMatch(candidateLangs: string[], projectStack: string[]): number {
  if (projectStack.length === 0) return 0;
  const normalised = (s: string) => s.toLowerCase().trim();
  const matched = projectStack.filter((tech) =>
    candidateLangs.some((lang) => normalised(lang).includes(normalised(tech)) ||
      normalised(tech).includes(normalised(lang)))
  );
  return Math.round((matched.length / projectStack.length) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Mermaid label escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use as a Mermaid quadrantChart point label.
 *
 * Mermaid quadrantChart labels are placed inside the chart definition.
 * Dangerous characters: quotes (break string delimiters), brackets,
 * newlines, semicolons (end of statement), colons (separator in axis defs).
 *
 * Strategy: replace all non-alphanumeric/space/hyphen chars with a space,
 * then trim and collapse whitespace. This is deliberately conservative —
 * any hostile injection text becomes inert whitespace.
 */
export function escapeMermaidLabel(label: string): string {
  // Strip everything except letters, digits, spaces, hyphens, underscores
  return label.replace(/[^a-zA-Z0-9 \-_]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

// ---------------------------------------------------------------------------
// Mermaid quadrantChart builder
// ---------------------------------------------------------------------------

export interface DiagramPoint {
  label: string;
  /** x-axis: trust score 0–1 */
  trustScore: number;
  /** y-axis: stack match score 0–1 */
  stackMatch: number;
}

export interface BuildDiagramResult {
  ok: true;
  mermaid: string;
  evidenceUrls: string[];
}

export interface BuildDiagramFallback {
  ok: false;
  fallbackText: string;
}

/**
 * Build a validated Mermaid quadrantChart from diagram points.
 *
 * Returns ok:false if:
 * - Any escaped label is empty after sanitisation
 * - The generated diagram fails the structural guard check
 *
 * securityLevel: 'strict' is set by the renderer (GitHubDiagram component),
 * not here — this function only produces the diagram definition string.
 */
export function buildQuadrantDiagram(
  points: DiagramPoint[],
  axisLabels?: { xLow?: string; xHigh?: string; yLow?: string; yHigh?: string }
): BuildDiagramResult | BuildDiagramFallback {
  if (points.length === 0) {
    return {
      ok: false,
      fallbackText: "No candidates to plot — run vetting first.",
    };
  }

  const xLow = escapeMermaidLabel(axisLabels?.xLow ?? "Low trust");
  const xHigh = escapeMermaidLabel(axisLabels?.xHigh ?? "High trust");
  const yLow = escapeMermaidLabel(axisLabels?.yLow ?? "Low stack match");
  const yHigh = escapeMermaidLabel(axisLabels?.yHigh ?? "High stack match");

  const lines: string[] = [
    "quadrantChart",
    "    title Candidate Analysis",
    `    x-axis ${xLow} --> ${xHigh}`,
    `    y-axis ${yLow} --> ${yHigh}`,
    "    quadrant-1 Top picks",
    "    quadrant-2 Strong skills - grow trust",
    "    quadrant-3 Needs development",
    "    quadrant-4 High trust - partial match",
  ];

  for (const point of points) {
    const escaped = escapeMermaidLabel(point.label);
    if (!escaped) {
      return {
        ok: false,
        fallbackText: `Label sanitisation failed for a candidate — diagram cannot be rendered safely.`,
      };
    }
    // Clamp coordinates to [0.05, 0.95] to keep points visible within chart
    const x = Math.max(0.05, Math.min(0.95, point.trustScore));
    const y = Math.max(0.05, Math.min(0.95, point.stackMatch));
    lines.push(`    ${escaped}: [${x.toFixed(2)}, ${y.toFixed(2)}]`);
  }

  const diagram = lines.join("\n");

  // Structural guard: verify the output has the expected shape before returning.
  // This is a lightweight check — full parse happens in the browser via mermaid.parse().
  if (!diagramStructureGuard(diagram)) {
    console.error("[buildQuadrantDiagram] structure guard failed. Raw diagram:\n", diagram);
    return {
      ok: false,
      fallbackText: "Diagram structure validation failed — showing text fallback.",
    };
  }

  // Collect evidence URLs from all points (none here — caller supplies them separately)
  return { ok: true, mermaid: diagram, evidenceUrls: [] };
}

/**
 * Structural guard: verify the diagram string matches expected quadrantChart shape.
 * Checks:
 * 1. Starts with "quadrantChart"
 * 2. Contains x-axis and y-axis declarations
 * 3. Contains at least one point pattern: "label: [x, y]"
 * 4. No raw angle brackets, script tags, or event handlers that could indicate injection
 */
export function diagramStructureGuard(diagram: string): boolean {
  if (!diagram.startsWith("quadrantChart")) return false;
  if (!diagram.includes("x-axis")) return false;
  if (!diagram.includes("y-axis")) return false;
  // Must have at least one point: alphanumeric label followed by [number, number]
  if (!/[a-zA-Z0-9].*:\s*\[\d+\.\d+,\s*\d+\.\d+\]/.test(diagram)) return false;
  // Injection guard: reject standalone angle brackets (but allow --> which is valid Mermaid axis arrow syntax),
  // and reject script/event-handler keywords.
  // Strip all --> occurrences first so the > inside them doesn't trigger the angle-bracket check.
  const withoutArrows = diagram.replace(/-->/g, "");
  if (/<|>/.test(withoutArrows)) return false;
  if (/script|onerror|onload|javascript:/i.test(diagram)) return false;
  return true;
}
