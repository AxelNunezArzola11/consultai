/**
 * Derive vetting requirements from a project record.
 *
 * Priority order (first non-empty source wins):
 *  1. structuredBrief.goals  — legacy/seed projects that still use the old brief format.
 *  2. structuredPlan milestones — the BriefAgent writes here for all real projects.
 *     Each milestone's description is a meaningful deliverable / skill area.
 *  3. project.title — last resort: ensures requirements is never empty.
 *
 * The LLM receives an empty requirements array as `[]`, which causes it to
 * produce zero matches and a trust score of 0 for every candidate.  This
 * function guarantees at least one requirement is returned.
 */

export function requirementsFromProject(project: {
  title: string;
  structuredBrief?: unknown;
  structuredPlan?: unknown;
}): Array<{ id: string; description: string }> {
  // ── 1. structuredBrief.goals ─────────────────────────────────────────────
  const brief = project.structuredBrief as { goals?: unknown } | null | undefined;
  const goals = Array.isArray(brief?.goals) ? (brief!.goals as unknown[]) : [];
  const goalStrings = goals
    .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
    .map((g) => g.trim());

  if (goalStrings.length > 0) {
    return goalStrings.map((g, i) => ({ id: `skill-${i + 1}`, description: g }));
  }

  // ── 2. structuredPlan milestones ─────────────────────────────────────────
  // BriefPlan shape: { projectTitle, projectSummary, milestones: [{ id, title, description, ... }] }
  const plan = project.structuredPlan as {
    milestones?: Array<{ id?: string; title?: string; description?: string }>;
    projectSummary?: string;
  } | null | undefined;

  const milestones = Array.isArray(plan?.milestones) ? plan!.milestones : [];
  const milestoneReqs: Array<{ id: string; description: string }> = [];

  milestones.forEach((m, i) => {
    // Prefer milestone description (most informative), fall back to title.
    const text = (m.description ?? m.title ?? "").trim();
    if (text.length > 0) {
      milestoneReqs.push({ id: `skill-${i + 1}`, description: text });
    }
  });

  if (milestoneReqs.length > 0) {
    return milestoneReqs;
  }

  // structuredPlan.projectSummary is a single-sentence description — use it
  // as one requirement if milestones produced nothing.
  const summary = (plan?.projectSummary ?? "").trim();
  if (summary.length > 0) {
    return [{ id: "skill-1", description: summary }];
  }

  // ── 3. project.title (guaranteed non-empty by DB schema) ─────────────────
  return [{ id: "skill-1", description: project.title.trim() }];
}
