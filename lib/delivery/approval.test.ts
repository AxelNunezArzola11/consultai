/**
 * Delivery Agent — approval flow + agent tool list tests
 *
 * Tests (no real DB or GitHub calls — all mocked):
 * 1.  Approval without a valid proposal → 404
 * 2.  Double approval is idempotent — returns existing "approved" state
 * 3.  Proposal with status "superseded" → 409
 * 4.  Non-company role → 403
 * 5.  Missing proposalId/decision → 400
 * 6.  Decision must be approved/rejected → 400
 * 7.  Approved without recipientEmail → 400
 * 8.  HEAD SHA changed after verification → proposal marked SUPERSEDED, 409
 * 9.  HEAD SHA unchanged → proceeds to decision
 * 10. Agent tool list contains NO money tools (executePayPalPayout absent)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock DB, auth, GitHub client
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/db/audit", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(BigInt(1)),
}));

vi.mock("@/lib/auth/role-cookie", () => ({
  getRoleFromCookie: vi.fn(),
  signRoleCookie: vi.fn().mockResolvedValue("consultai_role_v1=fake-token; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict"),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ ok: true, retryAfterSec: 0 }),
  getIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("@/lib/delivery/github-client", () => ({
  fetchPRDetails: vi.fn(),
  GitHubApiError: class GitHubApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));

import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { fetchPRDetails } from "@/lib/delivery/github-client";
import { db } from "@/lib/db";
import { POST } from "@/app/api/delivery/propose/approve/route";

const mockGetRole = vi.mocked(getRoleFromCookie);
const mockFetchPR = vi.mocked(fetchPRDetails);
const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(body: object): NextRequest {
  return new NextRequest("http://localhost/api/delivery/propose/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop_test123",
    milestoneId: "ms-001",
    runId: "run_test123",
    boundHeadSha: "abc123def456abc123def456abc123def456abc1",
    amountUsd: "100.00",
    policyDecision: "REQUIRES_APPROVAL",
    justification: "Looks good.",
    justificationFallback: false,
    status: "requires_approval",
    decidedBy: null,
    decidedAt: null,
    decisionNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockRun() {
  return {
    id: "run_test123",
    milestoneId: "ms-001",
    prOwner: "demo",
    prRepo: "repo",
    prNumber: 42,
    prUrl: "https://github.com/demo/repo/pull/42",
    headSha: "abc123def456abc123def456abc123def456abc1",
    status: "completed",
  };
}

function setupDbSelect(rows: Record<string, unknown>[]) {
  let callCount = 0;
  mockDb.select = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([rows[callCount++] ?? null]),
      }),
    }),
  }));
}

function setupDbUpdate() {
  mockDb.update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Delivery Agent — approval route", () => {
  beforeEach(() => {
    mockGetRole.mockResolvedValue("company");
    setupDbUpdate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("non-company role → 403", async () => {
    mockGetRole.mockResolvedValue("freelancer");
    const res = await POST(buildRequest({ proposalId: "prop_1", decision: "approved", recipientEmail: "a@b.com" }));
    expect(res.status).toBe(403);
  });

  it("missing proposalId → 400", async () => {
    const res = await POST(buildRequest({ decision: "approved" }));
    expect(res.status).toBe(400);
  });

  it("missing decision → 400", async () => {
    const res = await POST(buildRequest({ proposalId: "prop_1" }));
    expect(res.status).toBe(400);
  });

  it("invalid decision value → 400", async () => {
    const res = await POST(buildRequest({ proposalId: "prop_1", decision: "maybe" }));
    expect(res.status).toBe(400);
  });

  it("approved without recipientEmail → 400", async () => {
    const res = await POST(buildRequest({ proposalId: "prop_1", decision: "approved" }));
    expect(res.status).toBe(400);
  });

  it("proposal not found → 404", async () => {
    setupDbSelect([null as unknown as Record<string, unknown>]);
    const res = await POST(buildRequest({ proposalId: "prop_missing", decision: "rejected" }));
    expect(res.status).toBe(404);
  });

  it("double approval is idempotent — returns 200 with message", async () => {
    setupDbSelect([mockProposal({ status: "approved" })]);
    const res = await POST(buildRequest({ proposalId: "prop_test123", decision: "approved", recipientEmail: "a@b.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/already approved/i);
  });

  it("superseded proposal → 409", async () => {
    setupDbSelect([mockProposal({ status: "superseded" })]);
    const res = await POST(buildRequest({ proposalId: "prop_test123", decision: "approved", recipientEmail: "a@b.com" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/superseded/i);
  });

  it("HEAD SHA changed after verification → SUPERSEDED, 409", async () => {
    setupDbSelect([mockProposal(), mockRun()]);
    mockFetchPR.mockResolvedValueOnce({
      number: 42, title: "feat", body: null, state: "open",
      merged: false, draft: false,
      headSha: "NEW_SHA_that_changed_XXXXXXXXXXXXXXXXXXX",
      headRef: "feat", baseRef: "main",
      author: "alice", authorId: 1,
      htmlUrl: "https://github.com/demo/repo/pull/42",
      createdAt: "", updatedAt: "", mergedAt: null,
    });

    const res = await POST(buildRequest({
      proposalId: "prop_test123",
      decision: "approved",
      recipientEmail: "alice@example.com",
    }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/SHA changed/i);
    expect(body.action).toMatch(/re-submit/i);
  });

  it("HEAD SHA unchanged → proceeds, returns decision", async () => {
    setupDbSelect([mockProposal(), mockRun(), undefined as unknown as Record<string, unknown>]); // proposal, run, no payment row
    mockFetchPR.mockResolvedValueOnce({
      number: 42, title: "feat", body: null, state: "closed",
      merged: true, draft: false,
      headSha: "abc123def456abc123def456abc123def456abc1", // same SHA
      headRef: "feat", baseRef: "main",
      author: "alice", authorId: 1,
      htmlUrl: "https://github.com/demo/repo/pull/42",
      createdAt: "", updatedAt: "", mergedAt: "2024-01-01",
    });

    const res = await POST(buildRequest({
      proposalId: "prop_test123",
      decision: "approved",
      recipientEmail: "alice@example.com",
    }));

    // Should succeed (200) — payout may fail due to no payment row but that's ok
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("approved");
    expect(body.boundSha).toBe("abc123de");
  });
});

// ---------------------------------------------------------------------------
// Agent tool list — assert NO money tools
// ---------------------------------------------------------------------------

describe("DeliveryAgent tool list", () => {
  it("agent tool list contains no money/payout tools", async () => {
    /**
     * From the design spec and plan section 6.6:
     * "NEVER exposed to DeliveryAgent: pay_order, create_refund,
     *  accept_dispute_claim, and all invoice/subscription toolkit tools"
     *
     * The DeliveryAgent allowlist (lib/delivery) only exports:
     *   github-client, verifier, llm-step, policy-engine
     * None of these have payment execution tools.
     *
     * This test asserts that no delivery module exports a function named
     * after known money tools.
     */
    const modules = await Promise.all([
      import("@/lib/delivery/github-client"),
      import("@/lib/delivery/verifier"),
      import("@/lib/delivery/llm-step"),
      import("@/lib/delivery/policy-engine"),
    ]);

    const FORBIDDEN_TOOL_NAMES = [
      "executePayPalPayout",
      "createPayout",
      "payOrder",
      "captureOrder",
      "createRefund",
      "sendInvoice",
      "cancelSubscription",
    ];

    for (const mod of modules) {
      const exports = Object.keys(mod);
      for (const forbidden of FORBIDDEN_TOOL_NAMES) {
        expect(exports, `Delivery module must not export money tool: ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });
});
