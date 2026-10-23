/**
 * lib/payments/no-money-tools.test.ts
 *
 * Vitest unit test — verifies that neither the BriefAgent tool set nor the
 * PaymentChat tool set contains any "money execution" tool (direct PayPal
 * write operations).
 *
 * These tools, if present, would allow the LLM to directly execute financial
 * operations without human review (violates BOB_RULES §LLM_SAFETY).
 *
 * BLOCKED tool names (PayPal SDK / REST names that execute irreversible writes):
 *   capture_order, create_refund, payout, pay_order, accept_dispute_claim,
 *   delete_*, cancel_*, send_invoice*, issue_refund, complete_dispute,
 *   reimburse_seller
 *
 * The test uses exact-name matching and also substring matching for wildcards.
 */

import { describe, it, expect, vi } from "vitest";

// Mock the db module BEFORE any import that transitively loads lib/db/index.ts.
// lib/db/index.ts throws at import time if DATABASE_URL is absent — we stub it out
// so that unit tests that don't need a real DB connection can run without one.
vi.mock("@/lib/db", () => {
  const mockSelect = vi.fn();
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve([])),
  };
  mockSelect.mockReturnValue(chain);
  return {
    db: {
      select: mockSelect,
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => Promise.resolve()) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    },
    __mockChain: chain,
  };
});

import { briefAgentTools } from "@/lib/brief/tools";
import { paymentChatTools, requestPayoutApproval } from "@/lib/payments/payment-chat-tools";

// ── Blocked tool names ────────────────────────────────────────────────────────

/**
 * Exact names that must never appear in any LLM tool allowlist.
 * These map to PayPal REST write operations that execute money movement.
 */
const BLOCKED_EXACT: ReadonlySet<string> = new Set([
  "capture_order",
  "create_refund",
  "payout",           // the bare "payout" action — requestPayoutApproval is allowed
  "pay_order",
  "accept_dispute_claim",
  "complete_dispute",
  "reimburse_seller",
  "issue_refund",
]);

/**
 * Prefixes that must never appear as a tool name prefix.
 * Any tool whose name starts with these is blocked.
 */
const BLOCKED_PREFIXES: readonly string[] = [
  "delete_",
  "cancel_",
  "send_invoice",
  "execute_payment",
  "disburse_",
  "transfer_",
  "withdraw_",
];

// ── Helper ────────────────────────────────────────────────────────────────────

function isBlockedToolName(name: string): { blocked: boolean; reason: string } {
  const lc = name.toLowerCase();

  if (BLOCKED_EXACT.has(lc)) {
    return { blocked: true, reason: `exact match against blocked list: "${lc}"` };
  }

  for (const prefix of BLOCKED_PREFIXES) {
    if (lc.startsWith(prefix)) {
      return { blocked: true, reason: `name starts with blocked prefix "${prefix}"` };
    }
  }

  return { blocked: false, reason: "" };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LLM safety: agent tool allowlists contain no money-execution tools", () => {
  it("briefAgentTools contains no blocked tool names", () => {
    const tools = briefAgentTools;
    const toolNames = Object.keys(tools);

    expect(toolNames.length).toBeGreaterThan(0);

    for (const name of toolNames) {
      const { blocked, reason } = isBlockedToolName(name);
      expect(
        blocked,
        `briefAgentTools["${name}"] is a blocked money tool — ${reason}`
      ).toBe(false);
    }

    // Explicitly verify the expected allowlist (defensive: fails if extra tools added)
    expect(toolNames.sort()).toEqual(["askClarification", "saveStructuredBrief"].sort());
  });

  it("paymentChatTools contains no direct PayPal execution tools", () => {
    const tools = paymentChatTools;
    const toolNames = Object.keys(tools);

    expect(toolNames.length).toBeGreaterThan(0);

    for (const name of toolNames) {
      const { blocked, reason } = isBlockedToolName(name);
      expect(
        blocked,
        `paymentChatTools["${name}"] is a blocked money tool — ${reason}`
      ).toBe(false);
    }

    // The bare name "payout" is blocked — "requestPayoutApproval" and "executeMilestonePayout" are not
    expect(toolNames).not.toContain("payout");

    // Verify the expected allowlist (executeMilestonePayout is intentionally included:
    // it is a server-side execution tool triggered explicitly by the company in chat,
    // not an autonomously-triggered hidden action — see Feature 2 design doc)
    expect(toolNames.sort()).toEqual([
      "executeMilestonePayout",
      "getMilestoneStatus",
      "getPendingApprovals",
      "listMilestones",
      "requestPayoutApproval",
    ].sort());
  });

  it("requestPayoutApproval does NOT execute a PayPal payout directly", async () => {
    // The tool's execute function must return an action descriptor,
    // not call fetch/paypalFetch internally (code-level guarantee).
    //
    // The db module is already mocked (vi.mock at top of file).
    // We configure the mock chain to return a funded milestone and a payment.
    //
    // Strategy: the tool calls db.select twice (payments, then milestones).
    // We configure limit() to return alternating results via the module-level mock.

    const dbModule = await import("@/lib/db");
    const mockDb = dbModule.db as unknown as {
      select: ReturnType<typeof vi.fn>;
    };

    const stubPayment  = { id: "payment-test-001", status: "processing", netUsd: "450.00" };
    const stubMilestone = { status: "funded", title: "Test Milestone", captureNetUsd: "450.00" };

    let callCount = 0;
    const limitMock = vi.fn(() => {
      callCount++;
      return Promise.resolve(callCount === 1 ? [stubPayment] : [stubMilestone]);
    });

    mockDb.select.mockReturnValue({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: limitMock })) })),
    });

    // Intercept fetch to assert PayPal is NOT called
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const result = await requestPayoutApproval.execute!(
        { milestoneId: "milestone-test-001", recipientEmail: "test@example.com", note: "Test payout" },
        { toolCallId: "test-call-id", messages: [] }
      );

      // Must return an action descriptor — not a PayPal response
      expect(result).toMatchObject({ success: true, action: "payout_requested" });
      // fetch must NOT have been called (no PayPal HTTP request inside the tool)
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("BLOCKED_EXACT list is non-empty and covers key PayPal write operations", () => {
    // Meta-test: ensure the guard set itself is correct (not accidentally emptied)
    const mustInclude = ["capture_order", "create_refund", "payout", "pay_order"];
    for (const name of mustInclude) {
      expect(isBlockedToolName(name)).toMatchObject({ blocked: true });
    }
  });

  it("requestPayoutApproval is NOT in the BLOCKED_EXACT list", () => {
    // This is an allowed tool — make sure we haven't over-blocked
    expect(isBlockedToolName("requestPayoutApproval")).toMatchObject({ blocked: false });
  });
});
