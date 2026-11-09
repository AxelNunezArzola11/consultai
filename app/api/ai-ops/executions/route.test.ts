/**
 * Company-isolation regression tests for GET /api/ai-ops/executions.
 *
 * Company A must never receive Company B's executions, scheduling proposals,
 * payment proposals, approvals, verification runs, or audit rows — whether
 * or not A names a projectId. Explicit cross-company projectIds are rejected
 * (403, non-disclosing); omitted projectIds return A's scoped snapshot.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { GET as execGET } from "./route";
import { resetAuthStoreForTests } from "@/lib/auth/session";
import { DEMO_IDS } from "@/lib/demo/config";
import { getDemoTables, resetDemoStore } from "@/lib/demo/store";

function extractCookies(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies.map((c) => c.split(";")[0]).join("; ");
  }
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

async function registerCompany(email: string, companyName: string): Promise<string> {
  const res = await registerPOST(
    new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountType: "company",
        companyName,
        contactName: "Synthetic Owner",
        email,
        password: "SyntheticPass2026!",
        termsAccepted: true,
      }),
    })
  );
  expect(res.status).toBe(201);
  return extractCookies(res);
}

async function createProject(cookie: string, projectId: string): Promise<void> {
  const res = await projectsPOST(
    new NextRequest("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ projectId, title: `Synthetic ${projectId}` }),
    })
  );
  expect(res.status).toBe(201);
}

function execReq(projectId: string | undefined, cookie?: string): NextRequest {
  const url =
    projectId != null
      ? `http://localhost:3000/api/ai-ops/executions?projectId=${projectId}`
      : "http://localhost:3000/api/ai-ops/executions";
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new NextRequest(url, { headers });
}

type Snapshot = {
  agents: Array<Record<string, unknown>>;
  executions: Array<{ execution_id: string; project_id: string | null }>;
  scheduling_proposals: Array<{ proposal_id: string; project_id: string }>;
  payment_proposals: Array<{ proposal_id: string; milestone_id: string }>;
  pending_payment_approvals: Array<{ approval_id: string; milestone_id: string }>;
  verification_runs: Array<{ id: string; milestone_id: string }>;
  recent_audits: Array<{ id: string; entity_type: string; entity_id: string }>;
};

/** Seed one milestone + full AI-Ops artifact set owned by `projectId`. */
function seedProjectArtifacts(tag: string, projectId: string): void {
  const t = getDemoTables();
  const now = new Date();
  const msId = `aiops-ms-${tag}`;
  t.milestones.push({
    id: msId,
    projectId,
    title: `${tag} milestone`,
    description: null,
    budgetUsd: "100.00",
    dueDate: "2026-07-01",
    status: "planned",
    dependsOnId: null,
    offsetDays: null,
    startDate: "2026-06-01",
    version: 0,
    paypalOrderId: null,
    paypalCaptureId: null,
    captureGrossUsd: null,
    captureFeeUsd: null,
    captureNetUsd: null,
    currency: null,
    paypalPayoutBatchId: null,
    paypalPayoutItemId: null,
    idempotencyKey: null,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  t.agentExecutions.push({
    id: `aiops-exec-${tag}`,
    projectId,
    userRequest: `Synthetic ${tag} review`,
    intent: "project_review",
    supervisorDecision: { simulated: true },
    delegatedAgents: ["planning_agent"],
    handoffs: [],
    status: "completed",
    approvalStatus: "awaiting_approval",
    structuredOutputs: {},
    toolCalls: [],
    errors: [],
    retryCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    durationMs: 10,
    finalResult: `Synthetic ${tag} result`,
    requestedBy: "company-operator",
    decidedBy: null,
    decidedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  t.schedulingProposals.push({
    id: `aiops-sprop-${tag}`,
    projectId,
    executionId: `aiops-exec-${tag}`,
    proposedByAgent: "reschedule_agent",
    overallRisk: "low",
    totalDelayDays: 1,
    rationale: `Synthetic ${tag} rationale`,
    adjustments: [],
    conflicts: [],
    status: "pending_approval",
    decidedBy: null,
    decidedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  t.paymentProposals.push({
    id: `aiops-payprop-${tag}`,
    milestoneId: msId,
    runId: `aiops-run-${tag}`,
    boundHeadSha: "abc123",
    amountUsd: "100.00",
    policyDecision: "REQUIRES_APPROVAL",
    justification: `Synthetic ${tag} justification`,
    justificationFallback: false,
    status: "requires_approval",
    decidedBy: null,
    decidedAt: null,
    decisionNotes: null,
    createdAt: now,
    updatedAt: now,
  });
  t.payments.push({
    id: `aiops-pay-${tag}`,
    milestoneId: msId,
    candidateId: null,
    grossUsd: "100.00",
    feeUsd: "3.20",
    netUsd: "96.80",
    currency: "USD",
    payoutFeeUsd: null,
    paypalOrderId: null,
    paypalCaptureId: null,
    paypalPayoutBatchId: null,
    paypalPayoutItemId: null,
    senderBatchId: `PAY_aiops-pay-${tag}`,
    idempotencyKey: `aiops-idem-${tag}`,
    status: "pending",
    justification: null,
    evidenceSummary: null,
    createdAt: now,
    updatedAt: now,
  });
  t.approvals.push({
    id: `aiops-approval-${tag}`,
    paymentId: `aiops-pay-${tag}`,
    milestoneId: msId,
    requestedBy: "agent",
    decision: "pending",
    decidedBy: null,
    decidedAt: null,
    notes: null,
    createdAt: now,
  });
  t.verificationRuns.push({
    id: `aiops-verif-${tag}`,
    milestoneId: msId,
    prUrl: `https://github.com/synthetic/${tag}/pull/1`,
    prOwner: "synthetic",
    prRepo: tag,
    prNumber: 1,
    headSha: "abc123",
    prAuthor: "synthetic-dev",
    prMerged: false,
    prDraft: false,
    criteriaResults: null,
    flags: [],
    llmModelId: "simulated-demo-model",
    promptVersion: "demo-v1",
    durationMs: 100,
    policyDecision: "approve_recommended",
    justification: `Synthetic ${tag} verification`,
    justificationFallback: false,
    status: "completed",
    submittedBy: "synthetic-dev",
    createdAt: now,
    updatedAt: now,
  });
  t.auditLog.push({
    id: BigInt(tag === "alpha" ? 9101 : 9102),
    entityType: "milestone",
    entityId: msId,
    event: "SYNTHETIC_SEEDED",
    actor: "test",
    payload: { simulated: true },
    createdAt: now,
  });
}

describe("GET /api/ai-ops/executions company isolation", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("Company A snapshot without projectId contains no Company B data (every section)", async () => {
    const cookiesA = await registerCompany("aiops-a@consultai.test", "AiOps Alpha");
    const cookiesB = await registerCompany("aiops-b@consultai.test", "AiOps Beta");
    await createProject(cookiesA, "aiops-proj-alpha");
    await createProject(cookiesB, "aiops-proj-beta");
    seedProjectArtifacts("alpha", "aiops-proj-alpha");
    seedProjectArtifacts("beta", "aiops-proj-beta");

    const res = await execGET(execReq(undefined, cookiesA));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Snapshot;

    // A's own artifacts are present.
    expect(snap.executions.some((e) => e.execution_id === "aiops-exec-alpha")).toBe(true);
    expect(
      snap.scheduling_proposals.some((s) => s.proposal_id === "aiops-sprop-alpha")
    ).toBe(true);

    // No B-owned artifact in ANY section (serialized-string sweep + per-section).
    const serialized = JSON.stringify(snap);
    for (const marker of [
      "aiops-proj-beta",
      "aiops-exec-beta",
      "aiops-sprop-beta",
      "aiops-payprop-beta",
      "aiops-approval-beta",
      "aiops-verif-beta",
      "aiops-ms-beta",
      "aiops-pay-beta",
    ]) {
      expect(serialized).not.toContain(marker);
    }
    expect(
      snap.executions.every((e) => e.project_id !== "aiops-proj-beta")
    ).toBe(true);
    expect(
      snap.pending_payment_approvals.every((a) => a.milestone_id !== "aiops-ms-beta")
    ).toBe(true);
    expect(
      snap.verification_runs.every((v) => v.milestone_id !== "aiops-ms-beta")
    ).toBe(true);
    expect(
      snap.payment_proposals.every((p) => p.milestone_id !== "aiops-ms-beta")
    ).toBe(true);
    expect(snap.recent_audits.every((a) => a.entity_id !== "aiops-ms-beta")).toBe(true);
    // Telemetry is computed from scoped runs only: exactly A's 1 seeded
    // execution is counted (B's run and the TechNova fixtures are out).
    const supervisor = snap.agents.find((a) => a.agent_id === "supervisor_agent");
    expect(supervisor?.total_executions).toBe(1);
    expect(supervisor?.successful_executions).toBe(1);
  });

  it("Company A requesting Company B's projectId → 403 (non-disclosing)", async () => {
    const cookiesA = await registerCompany("aiops-a2@consultai.test", "AiOps Alpha2");
    const cookiesB = await registerCompany("aiops-b2@consultai.test", "AiOps Beta2");
    await createProject(cookiesA, "aiops-proj-alpha2");
    await createProject(cookiesB, "aiops-proj-beta2");

    const res = await execGET(execReq("aiops-proj-beta2", cookiesA));
    expect(res.status).toBe(403);
  });

  it("Company A requesting its own projectId → 200 narrowed to that project", async () => {
    const cookiesA = await registerCompany("aiops-a3@consultai.test", "AiOps Alpha3");
    await createProject(cookiesA, "aiops-proj-alpha3");
    seedProjectArtifacts("alpha", "aiops-proj-alpha3");

    const res = await execGET(execReq("aiops-proj-alpha3", cookiesA));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Snapshot;
    expect(snap.executions.length).toBeGreaterThan(0);
    expect(snap.executions.every((e) => e.project_id === "aiops-proj-alpha3")).toBe(true);
    expect(
      snap.scheduling_proposals.every((s) => s.project_id === "aiops-proj-alpha3")
    ).toBe(true);
  });

  it("unauthenticated caller → 403", async () => {
    expect((await execGET(execReq(undefined))).status).toBe(403);
    expect((await execGET(execReq(DEMO_IDS.project))).status).toBe(403);
  });

  it("demo session-less company holder → 200 TechNova fixtures (demo parity)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await execGET(execReq(undefined, companyCookie));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Snapshot;
    expect(
      snap.executions.some((e) => e.execution_id === "demo-exec-review-1")
    ).toBe(true);
  });

  it("live session-less company holder → 403 before any data access", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevSecret = process.env.ROLE_COOKIE_SECRET;
    try {
      process.env.DEMO_MODE = "false";
      process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
      const companyCookie = (await signRoleCookie("company")).split(";")[0];
      const res = await execGET(execReq(undefined, companyCookie));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_company_context");
    } finally {
      process.env.DEMO_MODE = prevDemo;
      if (prevSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
      else process.env.ROLE_COOKIE_SECRET = prevSecret;
    }
  });
});
