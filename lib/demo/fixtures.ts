/**
 * Offline demo fixtures — TechNova Solutions / Enterprise SaaS Implementation.
 *
 * Clearly-identified fictional data (all IDs prefixed "demo-") served ONLY
 * when DEMO_MODE=true. Every route resolves the same objects through the
 * in-memory store (lib/demo/store.ts), so IDs and relationships stay
 * consistent across dashboards, grids, timelines, and ledgers.
 *
 * Scenario shape (stable every day — dates anchor to "today minus 21 days"):
 * - $25,000 budget across 6 milestones, 8-week timeline
 * - Requirements: completed & paid (simulated payout)
 * - Frontend: funded but 3 days past due (delayed) + open dispute
 * - Backend: deliverable submitted, pending verification
 * - Integration: payment proposal awaiting human approval
 * - QA + Deployment: planned
 * - Rescheduling proposal shifting the delayed chain (+3 days)
 * - Contractor constraint: frontend consultant at capacity
 */

import {
  companies,
  projects,
  milestones,
  candidates,
  evidence,
  ndas,
  meetings,
  payments,
  approvals,
  disputes,
  auditLog,
  paypalWebhookDeliveries,
  verificationRuns,
  paymentProposals,
  agentExecutions,
  schedulingProposals,
  signals,
  cascadeLog,
} from "@/lib/db/schema";
import { DEMO_IDS } from "./config";

type Company = typeof companies.$inferSelect;
type Project = typeof projects.$inferSelect;
type Milestone = typeof milestones.$inferSelect;
type Candidate = typeof candidates.$inferSelect;
type Evidence = typeof evidence.$inferSelect;
type Nda = typeof ndas.$inferSelect;
type Meeting = typeof meetings.$inferSelect;
type Payment = typeof payments.$inferSelect;
type Approval = typeof approvals.$inferSelect;
type Dispute = typeof disputes.$inferSelect;
type Audit = typeof auditLog.$inferSelect;
type WebhookDelivery = typeof paypalWebhookDeliveries.$inferSelect;
type VerificationRun = typeof verificationRuns.$inferSelect;
type PaymentProposal = typeof paymentProposals.$inferSelect;
type AgentExecution = typeof agentExecutions.$inferSelect;
type SchedulingProposal = typeof schedulingProposals.$inferSelect;
type Signal = typeof signals.$inferSelect;
type Cascade = typeof cascadeLog.$inferSelect;

export interface DemoTables {
  companies: Company[];
  projects: Project[];
  milestones: Milestone[];
  candidates: Candidate[];
  evidence: Evidence[];
  ndas: Nda[];
  meetings: Meeting[];
  payments: Payment[];
  approvals: Approval[];
  paymentProposals: PaymentProposal[];
  disputes: Dispute[];
  verificationRuns: VerificationRun[];
  agentExecutions: AgentExecution[];
  schedulingProposals: SchedulingProposal[];
  signals: Signal[];
  cascadeLog: Cascade[];
  auditLog: Audit[];
  paypalWebhookDeliveries: WebhookDelivery[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function anchorDates(): { at: (dayOffset: number) => Date; iso: (dayOffset: number) => string } {
  const now = new Date();
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const anchor = startOfToday - 21 * DAY_MS; // project started 3 weeks ago
  return {
    at: (dayOffset: number) => new Date(anchor + dayOffset * DAY_MS),
    iso: (dayOffset: number) =>
      new Date(anchor + dayOffset * DAY_MS).toISOString().slice(0, 10),
  };
}

export function buildDemoTables(): DemoTables {
  const { at, iso } = anchorDates();
  const P = DEMO_IDS.project;
  const C = DEMO_IDS.company;
  const M = DEMO_IDS.milestones;

  const demoCompanies: Company[] = [
    {
      id: C,
      name: "TechNova Solutions",
      email: "ops@technova.example.com",
      paypalMerchantId: "DEMO-MERCHANT-TECHNOVA",
      createdAt: at(-60),
    },
  ];

  const demoProjects: Project[] = [
    {
      id: P,
      companyId: C,
      title: "Enterprise SaaS Implementation",
      rawBrief:
        "Replace our legacy on-premise console with a multi-tenant SaaS platform: " +
        "real-time analytics, natural-language reporting, and PayPal billing integration. " +
        "Eight-week delivery window with milestone-gated payouts.",
      structuredBrief: {
        summary: "Multi-tenant SaaS platform replacing the legacy console",
        context: "Legacy system cannot scale past 200 tenants; renewal risk on 3 enterprise accounts",
        goals: [
          "Real-time analytics pipeline",
          "Natural-language reporting",
          "PayPal billing integration",
          "SOC2-ready audit trail",
        ],
      },
      structuredPlan: null,
      sanitizedSummary:
        "A mid-size enterprise SaaS migration: analytics, reporting, and billing. " +
        "Full brief unlocks after NDA acceptance.",
      githubRepoUrl: "https://github.com/technova-demo/saas-platform",
      acceptanceCriteria: [
        { id: "ac-sso", description: "SSO login (SAML + OIDC) works for 3 pilot tenants", verifiable: true, verified: true },
        { id: "ac-realtime", description: "Dashboards refresh within 5 seconds of event ingest", verifiable: true, verified: false },
        { id: "ac-billing", description: "PayPal subscription webhooks reconcile within 60 seconds", verifiable: true, verified: false },
      ],
      status: "active",
      autoApproveThresholdUsd: "500.00",
      createdAt: at(-21),
      updatedAt: at(0),
    },
  ];

  const demoMilestones: Milestone[] = [
    {
      id: M.requirements,
      projectId: P,
      title: "Requirements & Architecture",
      description: "Discovery workshops, ADRs, data model, and API contracts",
      budgetUsd: "4000.00",
      dueDate: iso(7),
      status: "paid",
      dependsOnId: null,
      offsetDays: null,
      startDate: iso(0),
      version: 1,
      paypalOrderId: "DEMO-ORDER-REQ-001",
      paypalCaptureId: "DEMO-CAPTURE-REQ-001",
      captureGrossUsd: "4000.00",
      captureFeeUsd: "156.30",
      captureNetUsd: "3843.70",
      currency: "USD",
      paypalPayoutBatchId: "DEMO-PAYOUT-REQ-001",
      paypalPayoutItemId: "DEMO-PAYOUT-ITEM-001",
      idempotencyKey: "demo-idem-req-001",
      position: 0,
      createdAt: at(-21),
      updatedAt: at(-13),
    },
    {
      id: M.frontend,
      projectId: P,
      title: "Frontend Development",
      description: "Tenant console, design system, realtime dashboards",
      budgetUsd: "5500.00",
      dueDate: iso(18), // 3 days ago — DELAYED while still funded
      status: "funded",
      dependsOnId: M.requirements,
      offsetDays: 0,
      startDate: iso(7),
      version: 1,
      paypalOrderId: "DEMO-ORDER-FE-001",
      paypalCaptureId: "DEMO-CAPTURE-FE-001",
      captureGrossUsd: "5500.00",
      captureFeeUsd: "214.80",
      captureNetUsd: "5285.20",
      currency: "USD",
      paypalPayoutBatchId: null,
      paypalPayoutItemId: null,
      idempotencyKey: "demo-idem-fe-001",
      position: 1,
      createdAt: at(-21),
      updatedAt: at(-2),
    },
    {
      id: M.backend,
      projectId: P,
      title: "Backend Development",
      description: "APIs, event pipeline, billing webhooks, audit trail",
      budgetUsd: "6000.00",
      dueDate: iso(28),
      status: "verifying",
      dependsOnId: M.requirements,
      offsetDays: 0,
      startDate: iso(7),
      version: 2,
      paypalOrderId: "DEMO-ORDER-BE-001",
      paypalCaptureId: "DEMO-CAPTURE-BE-001",
      captureGrossUsd: "6000.00",
      captureFeeUsd: "234.30",
      captureNetUsd: "5765.70",
      currency: "USD",
      paypalPayoutBatchId: null,
      paypalPayoutItemId: null,
      idempotencyKey: "demo-idem-be-001",
      position: 2,
      createdAt: at(-21),
      updatedAt: at(0),
    },
    {
      id: M.integration,
      projectId: P,
      title: "Integration",
      description: "SSO rollout, tenant migration, billing reconciliation",
      budgetUsd: "4500.00",
      dueDate: iso(38),
      status: "pending_approval",
      dependsOnId: M.backend,
      offsetDays: 0,
      startDate: iso(28),
      version: 1,
      paypalOrderId: "DEMO-ORDER-INT-001",
      paypalCaptureId: "DEMO-CAPTURE-INT-001",
      captureGrossUsd: "4500.00",
      captureFeeUsd: "175.80",
      captureNetUsd: "4324.20",
      currency: "USD",
      paypalPayoutBatchId: null,
      paypalPayoutItemId: null,
      idempotencyKey: "demo-idem-int-001",
      position: 3,
      createdAt: at(-21),
      updatedAt: at(0),
    },
    {
      id: M.qa,
      projectId: P,
      title: "Quality Assurance",
      description: "E2E suites, load testing, security review",
      budgetUsd: "3000.00",
      dueDate: iso(49),
      status: "planned",
      dependsOnId: M.integration,
      offsetDays: 0,
      startDate: iso(38),
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
      position: 4,
      createdAt: at(-21),
      updatedAt: at(-21),
    },
    {
      id: M.deploy,
      projectId: P,
      title: "Deployment",
      description: "Production cutover, runbooks, handover",
      budgetUsd: "2000.00",
      dueDate: iso(56),
      status: "planned",
      dependsOnId: M.qa,
      offsetDays: 0,
      startDate: iso(49),
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
      position: 5,
      createdAt: at(-21),
      updatedAt: at(-21),
    },
  ];

  const demoCandidates: Candidate[] = [
    {
      id: DEMO_IDS.candidates.maya,
      projectId: P,
      name: "Maya Chen",
      email: "maya.chen@example.com",
      githubHandle: "maya-chen-demo",
      portfolioUrl: "https://example.com/maya-chen",
      trustScore: "0.91",
      canDo: [
        { skill: "React / Next.js", evidence_url: "https://github.com/maya-chen-demo/tenant-console", confidence: 0.93 },
        { skill: "Realtime dashboards (SSE/WebSocket)", evidence_url: "https://github.com/maya-chen-demo/live-charts", confidence: 0.9 },
        { skill: "Design systems", evidence_url: "https://example.com/maya-chen/case-study", confidence: 0.84 },
      ],
      cannotDo: [{ skill: "Go microservices", reason: "No public evidence of Go work" }],
      vettingSummary:
        "Lead frontend consultant. Strong realtime-dashboard evidence. Availability 20h/week; " +
        "currently at capacity (contractor constraint) until the reschedule lands.",
      rank: 1,
      status: "selected",
      rejectionReason: null,
      vettingConsentAt: at(-20),
      vettingRanAt: at(-19),
      createdAt: at(-20),
      updatedAt: at(-10),
    },
    {
      id: DEMO_IDS.candidates.raj,
      projectId: P,
      name: "Raj Patel",
      email: "raj.patel@example.com",
      githubHandle: "raj-patel-demo",
      portfolioUrl: "https://example.com/raj-patel",
      trustScore: "0.84",
      canDo: [
        { skill: "Node.js / Postgres APIs", evidence_url: "https://github.com/raj-patel-demo/event-pipeline", confidence: 0.88 },
        { skill: "PayPal webhooks & billing", evidence_url: "https://github.com/raj-patel-demo/billing-hooks", confidence: 0.82 },
      ],
      cannotDo: [{ skill: "Mobile development", reason: "No mobile evidence found" }],
      vettingSummary:
        "Backend consultant owning the event pipeline and billing webhooks. Availability 30h/week; workload healthy.",
      rank: 2,
      status: "nda_signed",
      rejectionReason: null,
      vettingConsentAt: at(-20),
      vettingRanAt: at(-19),
      createdAt: at(-20),
      updatedAt: at(-6),
    },
    {
      id: DEMO_IDS.candidates.lena,
      projectId: P,
      name: "Lena Fischer",
      email: "lena.fischer@example.com",
      githubHandle: "lena-fischer-demo",
      portfolioUrl: "https://example.com/lena-fischer",
      trustScore: "0.76",
      canDo: [
        { skill: "Playwright E2E testing", evidence_url: "https://github.com/lena-fischer-demo/e2e-suites", confidence: 0.86 },
        { skill: "Load testing (k6)", evidence_url: "https://example.com/lena-fischer/load-testing", confidence: 0.7 },
      ],
      cannotDo: [
        { skill: "PayPal API integration", reason: "No payments-related work found" },
        { skill: "Realtime streaming", reason: "Only synchronous patterns observed" },
      ],
      vettingSummary:
        "QA consultant shortlisted for the test phase. Availability 25h/week starting next sprint.",
      rank: 3,
      status: "shortlisted",
      rejectionReason: null,
      vettingConsentAt: at(-20),
      vettingRanAt: at(-19),
      createdAt: at(-20),
      updatedAt: at(-4),
    },
  ];

  const demoEvidence: Evidence[] = [
    {
      id: "demo-evidence-1",
      candidateId: DEMO_IDS.candidates.maya,
      sourceType: "github_repo",
      sourceUrl: "https://github.com/maya-chen-demo/tenant-console",
      title: "tenant-console",
      summary: "Multi-tenant React console with realtime SSE dashboards. 210 stars, maintained weekly.",
      relevanceScore: "0.93",
      fetchedAt: at(-19),
    },
    {
      id: "demo-evidence-2",
      candidateId: DEMO_IDS.candidates.raj,
      sourceType: "github_repo",
      sourceUrl: "https://github.com/raj-patel-demo/billing-hooks",
      title: "billing-hooks",
      summary: "PayPal subscription webhook handler with signature verification and idempotent reconciliation.",
      relevanceScore: "0.82",
      fetchedAt: at(-19),
    },
  ];

  const demoNdas: Nda[] = [
    {
      id: DEMO_IDS.ndaMaya,
      candidateId: DEMO_IDS.candidates.maya,
      projectId: P,
      templateVersion: "1.0.0",
      contentHash: "demo-hash-maya-nda",
      pdfUrl: null,
      inviteToken: null,
      inviteTokenHash: "demo-sealed-maya",
      inviteTokenUsed: true,
      inviteTokenRateLimit: 1,
      inviteTokenExpiresAt: at(-16),
      status: "accepted",
      sentAt: at(-17),
      acceptedAt: at(-16),
      acceptedName: "Maya Chen",
      acceptedIp: "203.0.113.10",
      documentHash: "demo-hash-maya-nda",
      expiresAt: at(700),
      createdAt: at(-17),
    },
    {
      id: DEMO_IDS.ndaRaj,
      candidateId: DEMO_IDS.candidates.raj,
      projectId: P,
      templateVersion: "1.0.0",
      contentHash: "demo-hash-raj-nda",
      pdfUrl: null,
      inviteToken: null,
      inviteTokenHash: "demo-sealed-raj",
      inviteTokenUsed: true,
      inviteTokenRateLimit: 1,
      inviteTokenExpiresAt: at(-16),
      status: "accepted",
      sentAt: at(-17),
      acceptedAt: at(-15),
      acceptedName: "Raj Patel",
      acceptedIp: "203.0.113.11",
      documentHash: "demo-hash-raj-nda",
      expiresAt: at(700),
      createdAt: at(-17),
    },
  ];

  const demoMeetings: Meeting[] = [
    {
      id: "demo-meeting-maya",
      candidateId: DEMO_IDS.candidates.maya,
      projectId: P,
      calBookingUid: "demo-booking-maya",
      scheduledAt: at(-12),
      status: "held",
      calCancelReason: null,
      bookingLink: "https://cal.example.com/demo/technova-maya",
      createdAt: at(-14),
      updatedAt: at(-12),
    },
    {
      id: "demo-meeting-raj",
      candidateId: DEMO_IDS.candidates.raj,
      projectId: P,
      calBookingUid: "demo-booking-raj",
      scheduledAt: at(2),
      status: "scheduled",
      calCancelReason: null,
      bookingLink: "https://cal.example.com/demo/technova-raj",
      createdAt: at(-3),
      updatedAt: at(-3),
    },
  ];

  const demoPayments: Payment[] = [
    {
      id: "demo-pay-requirements",
      milestoneId: M.requirements,
      candidateId: DEMO_IDS.candidates.maya,
      grossUsd: "4000.00",
      feeUsd: "156.30",
      netUsd: "3843.70",
      currency: "USD",
      payoutFeeUsd: "0.25",
      paypalOrderId: "DEMO-ORDER-REQ-001",
      paypalCaptureId: "DEMO-CAPTURE-REQ-001",
      paypalPayoutBatchId: "DEMO-PAYOUT-REQ-001",
      paypalPayoutItemId: "DEMO-PAYOUT-ITEM-001",
      senderBatchId: "PAY_demo-pay-requirements",
      idempotencyKey: "demo-idem-pay-req-001",
      status: "succeeded",
      justification: "Requirements & Architecture accepted by TechNova (simulated).",
      evidenceSummary: [{ criterion: "ac-sso", passed: true, evidence_url: null, notes: "SSO verified in staging (simulated)" }],
      createdAt: at(-13),
      updatedAt: at(-13),
    },
    {
      id: "demo-pay-integration",
      milestoneId: M.integration,
      candidateId: DEMO_IDS.candidates.raj,
      grossUsd: "4500.00",
      feeUsd: "175.80",
      netUsd: "4324.20",
      currency: "USD",
      payoutFeeUsd: null,
      paypalOrderId: "DEMO-ORDER-INT-001",
      paypalCaptureId: "DEMO-CAPTURE-INT-001",
      paypalPayoutBatchId: null,
      paypalPayoutItemId: null,
      senderBatchId: "PAY_demo-pay-integration",
      idempotencyKey: "demo-idem-pay-int-001",
      status: "pending",
      justification: "Integration payout proposed by Finance Agent — awaiting human approval (simulated).",
      evidenceSummary: null,
      createdAt: at(0),
      updatedAt: at(0),
    },
  ];

  const demoApprovals: Approval[] = [
    {
      id: DEMO_IDS.approval,
      paymentId: "demo-pay-integration",
      milestoneId: M.integration,
      requestedBy: "agent",
      decision: "pending",
      decidedBy: null,
      decidedAt: null,
      notes: "Amount $4,324.20 exceeds the $500 auto-approve threshold — explicit human authorization required.",
      createdAt: at(0),
    },
  ];

  const demoPaymentProposals: PaymentProposal[] = [
    {
      id: DEMO_IDS.paymentProposal,
      milestoneId: M.integration,
      runId: "demo-run-integration-1",
      boundHeadSha: "demoheadsha000000000000000000000000000001",
      amountUsd: "4324.20",
      policyDecision: "REQUIRES_APPROVAL",
      justification: "Verified deliverable; amount exceeds auto-approve threshold (simulated assessment).",
      justificationFallback: false,
      status: "requires_approval",
      decidedBy: null,
      decidedAt: null,
      decisionNotes: null,
      createdAt: at(0),
      updatedAt: at(0),
    },
  ];

  const demoDisputes: Dispute[] = [
    {
      id: DEMO_IDS.dispute,
      milestoneId: M.frontend,
      paymentId: null,
      paypalDisputeId: "DEMO-DISP-001",
      status: "waiting_for_seller",
      claimedBy: "company",
      paypalStatus: "REQUIRED_ACTION",
      disputeReason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      disputeChannel: "INTERNAL",
      disputeLifeCycleStage: "INQUIRY",
      disputeAmountUsd: "1500.00",
      disputeAmountCurrency: "USD",
      evidence: [
        { type: "acceptance_criteria", url: null, description: "Approved dashboard mockups v3 (simulated)", source: "project_brief", submitted_at: null },
        { type: "delivery_diff", url: "https://github.com/technova-demo/saas-platform/pull/87", description: "Delivered UI deviates from mockups: missing realtime filters (simulated)", source: "github_pr", submitted_at: null },
      ],
      evidenceStatus: "submitted",
      evidenceSubmittedAt: at(-1),
      offerAmountUsd: null,
      offerSubmittedAt: null,
      resolutionOutcome: null,
      agentResolution:
        "Recommend requesting a revised delivery addressing the realtime-filter gap before releasing the frontend payout (simulated advisory — human decides).",
      humanEditedResponse: null,
      createdAt: at(-2),
      updatedAt: at(-1),
    },
  ];

  const demoVerificationRuns: VerificationRun[] = [
    {
      id: "demo-run-backend-1",
      milestoneId: M.backend,
      prUrl: "https://github.com/technova-demo/saas-platform/pull/92",
      prOwner: "technova-demo",
      prRepo: "saas-platform",
      prNumber: 92,
      headSha: "demoheadsha0000000000000000000000000000be",
      prAuthor: "raj-patel-demo",
      prMerged: false,
      prDraft: false,
      criteriaResults: [
        { criterionId: "ac-billing", kind: "objective", met: true, evidence: ["webhook handler + idempotency keys present (simulated)"] },
        { criterionId: "ac-realtime", kind: "objective", met: null, evidence: ["load test pending (simulated)"] },
      ],
      flags: [],
      llmModelId: "simulated-demo-model",
      promptVersion: "demo-v1",
      durationMs: 4200,
      policyDecision: "approve_recommended",
      justification: "Billing criteria met; realtime load test still pending. Recommend approval once the load test lands (simulated).",
      justificationFallback: false,
      status: "completed",
      submittedBy: "raj-patel-demo",
      createdAt: at(0),
      updatedAt: at(0),
    },
  ];

  const demoSchedulingProposals: SchedulingProposal[] = [
    {
      id: DEMO_IDS.schedulingProposal,
      projectId: P,
      executionId: "demo-exec-resched-1",
      proposedByAgent: "reschedule_agent",
      overallRisk: "medium",
      totalDelayDays: 3,
      rationale:
        "Frontend milestone is 3 days past due (contractor at capacity). Shift the dependent chain " +
        "by 3 days to protect the 8-week deadline (simulated proposal — requires human approval).",
      adjustments: [
        { milestone_id: M.frontend, field: "due_date", old_value: iso(18), new_value: iso(21), reason: "absorb contractor delay" },
        { milestone_id: M.integration, field: "due_date", old_value: iso(38), new_value: iso(41), reason: "Finish-to-Start propagation" },
        { milestone_id: M.qa, field: "due_date", old_value: iso(49), new_value: iso(52), reason: "Finish-to-Start propagation" },
        { milestone_id: M.deploy, field: "due_date", old_value: iso(56), new_value: iso(59), reason: "Finish-to-Start propagation" },
      ],
      conflicts: [
        { type: "resource", detail: "Maya Chen at 100% allocation during the shifted frontend window (simulated)" },
      ],
      status: "pending_approval",
      decidedBy: null,
      decidedAt: null,
      createdAt: at(0),
      updatedAt: at(0),
    },
  ];

  const demoAgentExecutions: AgentExecution[] = [
    {
      id: "demo-exec-review-1",
      projectId: P,
      userRequest: "Run a consolidated project review for Enterprise SaaS Implementation",
      intent: "project_review",
      supervisorDecision: {
        simulated: true,
        selected_agents: ["planning_agent", "talent_agent", "delivery_agent", "finance_agent", "reschedule_agent"],
        note: "Deterministic simulated trace for offline demo — not a real agent execution.",
      },
      delegatedAgents: ["planning_agent", "talent_agent", "delivery_agent", "finance_agent", "reschedule_agent"],
      handoffs: [
        { from: "supervisor", to: "planning_agent", at: at(-1).toISOString() },
        { from: "supervisor", to: "talent_agent", at: at(-1).toISOString() },
        { from: "supervisor", to: "delivery_agent", at: at(-1).toISOString() },
        { from: "supervisor", to: "finance_agent", at: at(-1).toISOString() },
        { from: "supervisor", to: "reschedule_agent", at: at(-1).toISOString() },
      ],
      status: "completed",
      approvalStatus: "awaiting_approval",
      structuredOutputs: {
        planning: { phases: 6, critical_path: ["requirements", "backend", "integration", "qa", "deploy"], simulated: true },
        talent: { recommended: "Maya Chen", trust: 0.91, simulated: true },
        delivery: { backend_pr: 92, recommendation: "approve_once_load_test_lands", simulated: true },
        finance: { pending_payout_usd: "4324.20", gate: "requires_human_approval", simulated: true },
        reschedule: { delay_days: 3, proposal: DEMO_IDS.schedulingProposal, simulated: true },
      },
      toolCalls: [],
      errors: [],
      retryCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationMs: 3800,
      finalResult:
        "Consolidated review (SIMULATED): 1 milestone paid, 1 delayed with an open dispute, " +
        "1 verification pending, 1 payout awaiting human approval, 1 reschedule proposal awaiting approval.",
      requestedBy: "company-operator",
      decidedBy: null,
      decidedAt: null,
      createdAt: at(-1),
      updatedAt: at(-1),
    },
    {
      id: "demo-exec-resched-1",
      projectId: P,
      userRequest: "Assess the 3-day frontend delay and propose a revised schedule",
      intent: "reschedule",
      supervisorDecision: { simulated: true, selected_agents: ["reschedule_agent"] },
      delegatedAgents: ["reschedule_agent"],
      handoffs: [{ from: "supervisor", to: "reschedule_agent", at: at(0).toISOString() }],
      status: "completed",
      approvalStatus: "awaiting_approval",
      structuredOutputs: {
        reschedule: { delay_days: 3, proposal: DEMO_IDS.schedulingProposal, simulated: true },
      },
      toolCalls: [],
      errors: [],
      retryCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationMs: 1200,
      finalResult: "Reschedule proposal demo-sched-1 prepared (SIMULATED) — awaiting human approval.",
      requestedBy: "company-operator",
      decidedBy: null,
      decidedAt: null,
      createdAt: at(0),
      updatedAt: at(0),
    },
  ];

  const demoSignals: Signal[] = [
    {
      id: "demo-signal-maya-1",
      candidateId: DEMO_IDS.candidates.maya,
      requirementId: "ac-realtime",
      signalType: "github_repo",
      sourceUrl: "https://github.com/maya-chen-demo/tenant-console",
      retrievedAt: at(-19),
      contentHash: "demo-content-hash-maya-1",
      extractedFact: "Maintains a realtime SSE dashboard starter with 210 stars (simulated).",
      quotedExcerpt: "realtime dashboard updates over Server-Sent Events (simulated excerpt)",
      confidence: "0.930",
      createdAt: at(-19),
    },
    {
      id: "demo-signal-maya-2",
      candidateId: DEMO_IDS.candidates.maya,
      requirementId: "ac-sso",
      signalType: "portfolio",
      sourceUrl: "https://example.com/maya-chen/case-study",
      retrievedAt: at(-19),
      contentHash: "demo-content-hash-maya-2",
      extractedFact: "Shipped SSO onboarding flow for 3 enterprise tenants (simulated).",
      quotedExcerpt: "led SSO rollout across three enterprise tenants (simulated excerpt)",
      confidence: "0.840",
      createdAt: at(-19),
    },
    {
      id: "demo-signal-raj-1",
      candidateId: DEMO_IDS.candidates.raj,
      requirementId: "ac-billing",
      signalType: "github_repo",
      sourceUrl: "https://github.com/raj-patel-demo/billing-hooks",
      retrievedAt: at(-19),
      contentHash: "demo-content-hash-raj-1",
      extractedFact: "PayPal webhook handler with signature verification (simulated).",
      quotedExcerpt: "verify paypal webhook signatures before reconciliation (simulated excerpt)",
      confidence: "0.820",
      createdAt: at(-19),
    },
    {
      id: "demo-signal-lena-1",
      candidateId: DEMO_IDS.candidates.lena,
      requirementId: "ac-realtime",
      signalType: "github_repo",
      sourceUrl: "https://github.com/lena-fischer-demo/e2e-suites",
      retrievedAt: at(-19),
      contentHash: "demo-content-hash-lena-1",
      extractedFact: "Playwright suites covering realtime flows (simulated).",
      quotedExcerpt: "end-to-end coverage for realtime dashboards (simulated excerpt)",
      confidence: "0.860",
      createdAt: at(-19),
    },
  ];

  const demoAudit: Audit[] = [
    { id: BigInt(9001), entityType: "project", entityId: P, event: "PROJECT_CREATED", actor: "ops@technova.example.com", payload: { title: "Enterprise SaaS Implementation", simulated: true }, createdAt: at(-21) },
    { id: BigInt(9002), entityType: "candidate", entityId: DEMO_IDS.candidates.maya, event: "VETTING_COMPLETE", actor: "agent", payload: { trustScore: 0.91, simulated: true }, createdAt: at(-19) },
    { id: BigInt(9003), entityType: "nda", entityId: DEMO_IDS.ndaMaya, event: "NDA_ACCEPTED", actor: "Maya Chen", payload: { simulated: true }, createdAt: at(-16) },
    { id: BigInt(9004), entityType: "milestone", entityId: M.requirements, event: "CAPTURE_COMPLETED", actor: "company", payload: { grossUsd: "4000.00", simulated: true }, createdAt: at(-14) },
    { id: BigInt(9005), entityType: "milestone", entityId: M.requirements, event: "PAYOUT_RELEASED", actor: "company-operator", payload: { batchId: "DEMO-PAYOUT-REQ-001", simulated: true }, createdAt: at(-13) },
    { id: BigInt(9006), entityType: "milestone", entityId: M.frontend, event: "CAPTURE_COMPLETED", actor: "company", payload: { grossUsd: "5500.00", simulated: true }, createdAt: at(-9) },
    { id: BigInt(9007), entityType: "dispute", entityId: DEMO_IDS.dispute, event: "DISPUTE_OPENED", actor: "system", payload: { amountUsd: "1500.00", simulated: true }, createdAt: at(-2) },
    { id: BigInt(9008), entityType: "milestone", entityId: M.backend, event: "DELIVERABLE_SUBMITTED", actor: "raj-patel-demo", payload: { pr: 92, simulated: true }, createdAt: at(0) },
    { id: BigInt(9009), entityType: "milestone", entityId: M.integration, event: "PAYOUT_PROPOSED", actor: "agent", payload: { amountUsd: "4324.20", simulated: true }, createdAt: at(0) },
    { id: BigInt(9010), entityType: "project", entityId: P, event: "RESCHEDULE_PROPOSED", actor: "agent", payload: { delayDays: 3, simulated: true }, createdAt: at(0) },
  ];

  const demoWebhooks: WebhookDelivery[] = [
    { eventId: "DEMO-WH-001", eventType: "CHECKOUT.ORDER.APPROVED", receivedAt: at(-9) },
    { eventId: "DEMO-WH-002", eventType: "CUSTOMER.DISPUTE.CREATED", receivedAt: at(-2) },
  ];

  return {
    companies: demoCompanies,
    projects: demoProjects,
    milestones: demoMilestones,
    candidates: demoCandidates,
    evidence: demoEvidence,
    ndas: demoNdas,
    meetings: demoMeetings,
    payments: demoPayments,
    approvals: demoApprovals,
    paymentProposals: demoPaymentProposals,
    disputes: demoDisputes,
    verificationRuns: demoVerificationRuns,
    agentExecutions: demoAgentExecutions,
    schedulingProposals: demoSchedulingProposals,
    signals: demoSignals,
    cascadeLog: [],
    auditLog: demoAudit,
    paypalWebhookDeliveries: demoWebhooks,
  };
}
