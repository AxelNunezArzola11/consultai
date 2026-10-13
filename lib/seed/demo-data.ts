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
 * - 3 milestones
 * - 3 candidates (rank 1–3) with trust scores, can/cannot-do arrays
 * - 3 evidence rows
 * - 1 NDA for candidate-1 (status: sent, with invite token)
 * - 1 meeting for candidate-1 (status: scheduled)
 * - 2 audit_log entries
 */

// Load .env.local for local runs
import "dotenv/config";

import { db } from "@/lib/db";
import {
  companies,
  projects,
  milestones,
  candidates,
  evidence,
  ndas,
  meetings,
  auditLog,
} from "@/lib/db/schema";

const now = new Date();
const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);

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
  // NDA for candidate-1 (status: sent)
  // -------------------------------------------------------------------------
  await db
    .insert(ndas)
    .values({
      id: "nda-1",
      candidateId: "candidate-1",
      projectId: "project-1",
      templateVersion: "v1.0",
      contentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // placeholder SHA-256
      inviteToken: "demo-invite-token-1",
      status: "sent",
      sentAt: now,
      expiresAt: in48h,
    })
    .onConflictDoNothing();

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
  // Audit log (2 seed entries)
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
    ])
    // audit_log uses bigserial PK — no conflict expected, but safe to ignore on re-run
    .onConflictDoNothing();

  console.log("✅ Seed complete.");
  console.log("   company-1, project-1, 3 milestones, 3 candidates, nda-1, meeting-1");
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
