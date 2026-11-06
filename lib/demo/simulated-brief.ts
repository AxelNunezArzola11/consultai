/**
 * Deterministic simulated BriefAgent output for offline DEMO_MODE.
 *
 * Produces the same text+```json plan shape the live agent emits so the
 * planning chat, canvas, and Approve & Save flow work unchanged. The text is
 * explicitly labeled SIMULATED and no LLM is contacted.
 */

import type { BriefPlan } from "@/lib/brief/schema";

export function buildSimulatedBriefPlan(projectTitle: string): BriefPlan {
  void projectTitle;
  return {
    projectTitle: "Enterprise SaaS Implementation",
    projectSummary:
      "SIMULATED plan: multi-tenant SaaS migration with analytics, reporting, and billing. " +
      "Deterministic demo output — no live AI was invoked.",
    totalBudgetUsd: 25000,
    milestones: [
      {
        id: "m1",
        title: "Requirements & Architecture",
        description: "Discovery workshops, ADRs, data model, and API contracts.",
        budgetUsd: 4000,
        dueDaysOffset: 7,
        acceptanceCriteria: [
          { id: "m1-c1", description: "ADRs approved for data model and tenancy", kind: "SUBJECTIVE" },
          { id: "m1-c2", description: "API contract spec merged", kind: "pr_merged" },
        ],
      },
      {
        id: "m2",
        title: "Frontend Development",
        description: "Tenant console, design system, realtime dashboards.",
        budgetUsd: 5500,
        dueDaysOffset: 21,
        acceptanceCriteria: [
          { id: "m2-c1", description: "Dashboard CI suite passes", kind: "ci_passes" },
          { id: "m2-c2", description: "Console bundle includes realtime filters", kind: "files_present", requiredFiles: ["apps/console/src/filters"] },
        ],
      },
      {
        id: "m3",
        title: "Backend Development",
        description: "APIs, event pipeline, billing webhooks, audit trail.",
        budgetUsd: 6000,
        dueDaysOffset: 28,
        acceptanceCriteria: [
          { id: "m3-c1", description: "Billing webhook handler merged with tests", kind: "pr_merged" },
          { id: "m3-c2", description: "No workflow or test tampering in delivery PRs", kind: "no_workflow_or_test_tampering" },
        ],
      },
      {
        id: "m4",
        title: "Integration",
        description: "SSO rollout, tenant migration, billing reconciliation.",
        budgetUsd: 4500,
        dueDaysOffset: 38,
        acceptanceCriteria: [
          { id: "m4-c1", description: "SSO login verified for 3 pilot tenants", kind: "SUBJECTIVE" },
          { id: "m4-c2", description: "Migration runbook reviewed and approved", kind: "required_review_approved" },
        ],
      },
      {
        id: "m5",
        title: "Quality Assurance",
        description: "E2E suites, load testing, security review.",
        budgetUsd: 3000,
        dueDaysOffset: 49,
        acceptanceCriteria: [
          { id: "m5-c1", description: "E2E suite passes on staging", kind: "ci_passes" },
        ],
      },
      {
        id: "m6",
        title: "Deployment",
        description: "Production cutover, runbooks, handover.",
        budgetUsd: 2000,
        dueDaysOffset: 56,
        acceptanceCriteria: [
          { id: "m6-c1", description: "Cutover checklist signed off", kind: "SUBJECTIVE" },
        ],
      },
    ],
  };
}

export function buildSimulatedBriefText(projectTitle: string): string {
  const plan = buildSimulatedBriefPlan(projectTitle);
  return (
    `SIMULATED PLANNING RUN (offline demo — no live AI invoked).\n\n` +
    `Here is a deterministic draft plan for "${plan.projectTitle}". ` +
    `Review it in the canvas, edit as needed, then Approve & Save to persist it to the demo workspace.\n\n` +
    "```json\n" +
    JSON.stringify(plan, null, 2) +
    "\n```\n"
  );
}
