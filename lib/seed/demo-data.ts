/**
 * Demo seed data for ConsultAI.
 *
 * Run with: npm run seed
 *
 * Idempotent: uses onConflictDoNothing() so re-running is safe.
 * DATABASE_URL must be set in .env.local.
 *
 * Seed contents:
 * - 1 company (Acme Corp)
 * - 1 active project (AI Dashboard Rebuild) with 3 acceptance criteria
 * - 3 milestones (milestone-2 funded with simulated capture)
 * - 3 candidates (rank 1–3) with trust scores, can/cannot-do arrays
 * - 3 evidence rows
 * - 1 NDA for candidate-1 (status: sent, Phase 4 hashed invite token —
 *   the invite URL is printed ONCE when first created)
 * - 1 meeting for candidate-1 (status: scheduled)
 * - 1 pending payment + approval for milestone-2 (human authorization demo)
 * - 1 internal dispute for milestone-2 (dispute management demo)
 * - 4 audit_log entries
 */

// Load .env.local for local runs
import "dotenv/config";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
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
} from "@/lib/db/schema";
import { buildNdaText } from "@/lib/nda/generate";
import {
  generateInviteToken,
  hashInviteToken,
  sha256Hex,
  tokenExpiresAt,
  ndaExpiresAt,
} from "@/lib/nda/invite-token";

const now = new Date();
const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

async function seed() {
  console.log("🌱 Seeding demo data...");

  // -------------------------------------------------------------------------
  // Company
  // -------------------------------------------------------------------------
  await db
    .insert(companies)
    .values({
      id: "company-1",
      name: "Acme Corp",
      email: "demo@acme.com",
      paypalMerchantId: "SANDBOX_MERCHANT",
    })
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // Project
  // -------------------------------------------------------------------------
  await db
    .insert(projects)
    .values({
      id: "project-1",
      companyId: "company-1",
      title: "AI Dashboard Rebuild",
      rawBrief:
        "We need to rebuild our internal analytics dashboard using modern AI-assisted tools. " +
        "The new system should support real-time data, natural language queries, " +
        "and integrate with our existing PayPal payment data.",
      structuredBrief: {
        summary: "Rebuild internal analytics dashboard with AI assistance",
        context: "Current dashboard is built on legacy tech stack and can't support real-time data",
        goals: [
          "Real-time data streaming",
          "Natural language query interface",
          "PayPal transaction integration",
          "Mobile-responsive design",
        ],
      },
      acceptanceCriteria: [
        {
          id: "ac-1",
          description:
            "Dashboard loads in under 2 seconds on a standard broadband connection",
          verifiable: true,
          verified: false,
        },
        {
          id: "ac-2",
          description:
            "Natural language query returns results within 5 seconds for datasets under 1M rows",
          verifiable: true,
          verified: false,
        },
        {
          id: "ac-3",
          description:
            "PayPal transaction data syncs within 60 seconds of a webhook event",
          verifiable: true,
          verified: false,
        },
      ],
      status: "active",
      autoApproveThresholdUsd: "500.00",
    })
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // Milestones
  // -------------------------------------------------------------------------
  await db
    .insert(milestones)
    .values([
      {
        id: "milestone-1",
        projectId: "project-1",
        title: "Design mockups & UX specification",
        description:
          "Figma designs for all dashboard views, mobile breakpoints, and component library",
        budgetUsd: "800.00",
        dueDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        status: "planned",
        position: 0,
      },
      {
        id: "milestone-2",
        projectId: "project-1",
        title: "Backend API & data pipeline",
        description:
          "REST API endpoints, real-time streaming, PayPal webhook integration",
        budgetUsd: "1500.00",
        dueDate: new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        status: "funded",
        position: 1,
        // Simulate a funded milestone for demo purposes
        paypalOrderId: "DEMO-ORDER-001",
        paypalCaptureId: "DEMO-CAPTURE-001",
        captureGrossUsd: "1500.00",
        captureFeeUsd: "58.50",
        captureNetUsd: "1441.50",
      },
      {
        id: "milestone-3",
        projectId: "project-1",
        title: "Frontend integration & testing",
        description:
          "Next.js frontend, E2E tests with Playwright, performance audit",
        budgetUsd: "1200.00",
        dueDate: new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        status: "planned",
        position: 2,
      },
    ])
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------
  await db
    .insert(candidates)
    .values([
      {
        id: "candidate-1",
        projectId: "project-1",
        name: "Alex Rivera",
        email: "alex.rivera@example.com",
        githubHandle: "alexrivera-dev",
        portfolioUrl: "https://alexrivera.dev",
        trustScore: "8.20",
        canDo: [
          {
            skill: "React / Next.js",
            evidence_url: "https://github.com/alexrivera-dev/next-dashboard",
            confidence: 0.92,
          },
          {
            skill: "Real-time data streaming",
            evidence_url: "https://github.com/alexrivera-dev/realtime-charts",
            confidence: 0.85,
          },
          {
            skill: "PayPal API integration",
            evidence_url: "https://alexrivera.dev/case-study/paypal",
            confidence: 0.78,
          },
        ],
        cannotDo: [
          {
            skill: "iOS/Android native apps",
            reason: "No public repos or portfolio items for native mobile",
          },
        ],
        vettingSummary:
          "Strong Next.js and real-time data background. Has shipped a production PayPal integration. " +
          "3 relevant repos with >50 stars each. Recommended rank 1.",
        rank: 1,
        status: "nda_sent",
      },
      {
        id: "candidate-2",
        projectId: "project-1",
        name: "Jordan Kim",
        email: "jordan.kim@example.com",
        githubHandle: "jordankim-eng",
        portfolioUrl: "https://jordankim.io",
        trustScore: "7.10",
        canDo: [
          {
            skill: "React / Next.js",
            evidence_url: "https://github.com/jordankim-eng/react-apps",
            confidence: 0.88,
          },
          {
            skill: "Data visualisation",
            evidence_url: "https://jordankim.io/portfolio",
            confidence: 0.81,
          },
        ],
        cannotDo: [
          {
            skill: "PayPal API integration",
            reason: "No evidence of PayPal or payments work found",
          },
        ],
        vettingSummary:
          "Solid React developer with good data viz portfolio. No payments experience found. Rank 2.",
        rank: 2,
        status: "pending",
      },
      {
        id: "candidate-3",
        projectId: "project-1",
        name: "Sam Okafor",
        email: "sam.okafor@example.com",
        githubHandle: "samokafor",
        portfolioUrl: "https://samokafor.com",
        trustScore: "6.50",
        canDo: [
          {
            skill: "React / Next.js",
            evidence_url: "https://github.com/samokafor/next-projects",
            confidence: 0.79,
          },
        ],
        cannotDo: [
          {
            skill: "Real-time data streaming",
            reason: "Only synchronous data fetching patterns observed",
          },
          {
            skill: "PayPal API integration",
            reason: "No payments-related work found",
          },
        ],
        vettingSummary:
          "Junior-to-mid React developer. Limited evidence for real-time or payments requirements. Rank 3.",
        rank: 3,
        status: "pending",
      },
    ])
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------
  await db
    .insert(evidence)
    .values([
      {
        id: "evidence-1",
        candidateId: "candidate-1",
        sourceType: "github_repo",
        sourceUrl: "https://github.com/alexrivera-dev/next-dashboard",
        title: "next-dashboard",
        summary:
          "Next.js 14 App Router dashboard with real-time chart updates via SSE. " +
          "123 stars, last commit 2 weeks ago.",
        relevanceScore: "0.92",
      },
      {
        id: "evidence-2",
        candidateId: "candidate-1",
        sourceType: "github_pr",
        sourceUrl:
          "https://github.com/some-org/paypal-nextjs/pull/42",
        title: "Add PayPal Orders v2 integration",
        summary:
          "Merged PR adding PayPal JS SDK v6, capture route, and webhook handler with signature verification.",
        relevanceScore: "0.85",
      },
      {
        id: "evidence-3",
        candidateId: "candidate-2",
        sourceType: "portfolio",
        sourceUrl: "https://jordankim.io/portfolio",
        title: "Analytics Dashboard — Acme Finance",
        summary:
          "Case study showing D3.js + React dashboard shipped to production. " +
          "Mentions Recharts as secondary library.",
        relevanceScore: "0.75",
      },
    ])
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // NDA for candidate-1 (status: sent, Phase 4 secure token)
  // -------------------------------------------------------------------------
  // The raw token is hashed before storage and printed ONCE below. Re-runs
  // keep the existing row; operators can reissue a link via the demo inbox.
  const [existingNda] = await db
    .select({ id: ndas.id })
    .from(ndas)
    .where(eq(ndas.id, "nda-1"))
    .limit(1);

  let seedInvitePath: string | null = null;
  if (!existingNda) {
    const rawToken = generateInviteToken();
    const documentText = buildNdaText({
      projectTitle: "AI Dashboard Rebuild",
      companyName: "Acme Corp",
      candidateName: "Alex Rivera",
      date: now.toISOString().split("T")[0],
    });
    const documentHash = sha256Hex(documentText);
    await db.insert(ndas).values({
      id: "nda-1",
      candidateId: "candidate-1",
      projectId: "project-1",
      templateVersion: "1.0.0",
      contentHash: documentHash,
      documentHash,
      pdfUrl: null,
      inviteToken: null,
      inviteTokenHash: hashInviteToken(rawToken),
      inviteTokenUsed: false,
      inviteTokenRateLimit: 0,
      inviteTokenExpiresAt: tokenExpiresAt(),
      status: "sent",
      sentAt: now,
      expiresAt: ndaExpiresAt(),
    });
    seedInvitePath = `/invite/nda-1:${rawToken}`;
  }

  // -------------------------------------------------------------------------
  // Meeting for candidate-1 (status: scheduled)
  // -------------------------------------------------------------------------
  await db
    .insert(meetings)
    .values({
      id: "meeting-1",
      candidateId: "candidate-1",
      projectId: "project-1",
      scheduledAt: tomorrow,
      status: "scheduled",
      bookingLink: "https://cal.com/demo/consultai-intro",
    })
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // Pending payment + approval for milestone-2 (human authorization demo)
  // -------------------------------------------------------------------------
  await db
    .insert(payments)
    .values({
      id: "payment-2",
      milestoneId: "milestone-2",
      candidateId: "candidate-1",
      grossUsd: "1500.00",
      feeUsd: "58.50",
      netUsd: "1441.50",
      currency: "USD",
      paypalOrderId: "DEMO-ORDER-001",
      paypalCaptureId: "DEMO-CAPTURE-001",
      senderBatchId: "PAY_payment-2",
      idempotencyKey: "seed-idem-payment-2",
      status: "pending",
      justification:
        "Backend API milestone accepted pending human payout authorization (seeded demo).",
    })
    .onConflictDoNothing();

  await db
    .insert(approvals)
    .values({
      id: "approval-1",
      paymentId: "payment-2",
      milestoneId: "milestone-2",
      requestedBy: "agent",
      decision: "pending",
      notes:
        "Amount $1,441.50 exceeds the $500 auto-approve threshold — seeded for the approval demo.",
    })
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // Internal dispute for milestone-2 (dispute management demo)
  // -------------------------------------------------------------------------
  await db
    .insert(disputes)
    .values({
      id: "dispute-1",
      milestoneId: "milestone-2",
      paymentId: "payment-2",
      paypalDisputeId: null,
      status: "open",
      claimedBy: "company",
      disputeReason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      disputeChannel: "INTERNAL",
      disputeLifeCycleStage: "INQUIRY",
      disputeAmountUsd: "500.00",
      disputeAmountCurrency: "USD",
      evidence: [
        {
          type: "acceptance_criteria",
          description:
            "ac-3 requires PayPal sync within 60s; seeded delivery report shows 4-minute lag (fictional).",
          source: "project_brief",
        },
      ],
      evidenceStatus: "submitted",
      evidenceSubmittedAt: now,
      agentResolution:
        "Seeded advisory: request a revised delivery addressing the sync lag before payout release. Human decides.",
    })
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // Audit log (4 seed entries)
  // -------------------------------------------------------------------------
  await db
    .insert(auditLog)
    .values([
      {
        entityType: "project",
        entityId: "project-1",
        event: "PROJECT_CREATED",
        actor: "demo@acme.com",
        payload: { title: "AI Dashboard Rebuild" },
      },
      {
        entityType: "candidate",
        entityId: "candidate-1",
        event: "NDA_SENT",
        actor: "system",
        payload: { ndaId: "nda-1", candidateName: "Alex Rivera" },
      },
      {
        entityType: "payment",
        entityId: "payment-2",
        event: "PAYOUT_PROPOSED",
        actor: "agent",
        payload: { amountUsd: "1441.50" },
      },
      {
        entityType: "dispute",
        entityId: "dispute-1",
        event: "DISPUTE_OPENED",
        actor: "system",
        payload: { amountUsd: "500.00" },
      },
    ])
    // audit_log uses bigserial PK — no conflict expected, but safe to ignore on re-run
    .onConflictDoNothing();

  console.log("✅ Seed complete.");
  console.log("   company-1, project-1, 3 milestones, 3 candidates, nda-1, meeting-1,");
  console.log("   payment-2 + approval-1 (pending), dispute-1 (open)");
  if (seedInvitePath) {
    console.log("");
    console.log("   NDA invite for Alex Rivera (shown ONCE — the raw token is not stored):");
    console.log(`   ${seedInvitePath}`);
  } else {
    console.log("   nda-1 already existed — reissue its link from /demo-inbox if needed.");
  }
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
