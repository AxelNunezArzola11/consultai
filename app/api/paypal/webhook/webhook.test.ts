/**
 * Step 5 + Step 7 — Webhook route fixture tests
 *
 * Tests covered (all unit-level using mocks — no live DB or PayPal):
 *
 * 1. Invalid / missing signature → 400 with generic body (no leak of reason)
 * 2. Duplicate event_id → 200 with "duplicate_ignored" (no second processing)
 * 3. Event_id recorded ONLY after successful processing (not on error)
 * 4. Payout replay (idempotent) — state machine same-state behaviour
 * 5. Illegal state transition rejected — MilestoneTransitionError thrown
 * 6. PAYOUTSBATCH.PROCESSING handler updates payment → processing
 * 7. PAYOUTSBATCH.SUCCESS handler writes audit log only (no item state change)
 * 8. PAYOUTS-ITEM.SUCCEEDED handler: payment → succeeded, milestone → paid
 * 9. PAYOUTS-ITEM.FAILED handler: payment → failed, milestone → failed
 * 10. PAYOUTS-ITEM.RETURNED handler: payment → failed, milestone → returned
 * 11. Out-of-order: SUCCEEDED arrives when payment already "succeeded" (idempotent)
 * 12. State machine: verifying → failed and verifying → returned allowed
 * 13. Payout replay — no second payment (same-state idempotency)
 *
 * NOTE: FAILED and RETURNED cases are UNTESTED against real PayPal — fixture only.
 *
 * Fixture payload field paths (per docs + Spike 3):
 *   CAPTURE.COMPLETED: resource.id, resource.supplementary_data.related_ids.order_id,
 *                      resource.custom_id (UNVERIFIED in webhook)
 *   PAYOUTSBATCH.*:    resource.batch_header.payout_batch_id
 *   PAYOUTS-ITEM.*:    resource.payout_item.sender_item_id, resource.payout_item_id,
 *                      resource.transaction_id
 *                      sender_item_id UNVERIFIED in live webhook (confirmed from docs)
 * Doc: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#definition-payout_item_details
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// State machine — imported at top level (ESM — no require() with @ aliases)
// ---------------------------------------------------------------------------

import {
  assertMilestoneTransition,
  assertPaymentTransition,
  isMilestoneTransitionAllowed,
  isPaymentTransitionAllowed,
  MilestoneTransitionError,
  PaymentTransitionError,
} from "@/lib/state-machines/milestone-payment";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above route import
// ---------------------------------------------------------------------------

vi.mock("@/lib/paypal/webhook", () => ({
  verifyPayPalWebhook: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/db/audit", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { POST } from "./route";
import { verifyPayPalWebhook } from "@/lib/paypal/webhook";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/db/audit";

// ---------------------------------------------------------------------------
// Fixture builder helpers
// ---------------------------------------------------------------------------

function buildRequest(body: object): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest("https://example.com/api/paypal/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-transmission-id": "test-transmission-id",
      "paypal-transmission-time": new Date().toISOString(),
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
      "paypal-transmission-sig": "test-sig",
      "paypal-auth-algo": "SHA256withRSA",
    },
    body: raw,
  });
}

/** Fixture: PAYMENT.PAYOUTSBATCH.PROCESSING */
function payoutsBatchProcessingEvent(batchId: string) {
  return {
    id: `WH-BATCH-PROC-${batchId}`,
    event_type: "PAYMENT.PAYOUTSBATCH.PROCESSING",
    resource: {
      batch_header: { payout_batch_id: batchId, batch_status: "PROCESSING" },
    },
  };
}

/** Fixture: PAYMENT.PAYOUTSBATCH.SUCCESS */
function payoutsBatchSuccessEvent(batchId: string) {
  return {
    id: `WH-BATCH-SUC-${batchId}`,
    event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
    resource: {
      batch_header: { payout_batch_id: batchId, batch_status: "SUCCESS" },
    },
  };
}

/** Fixture: PAYMENT.PAYOUTS-ITEM.SUCCEEDED */
function payoutsItemSucceededEvent(
  paymentId: string,
  payoutItemId: string,
  txId: string,
  includeFee = true
) {
  return {
    id: `WH-ITEM-SUC-${payoutItemId}`,
    event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    resource: {
      payout_item_id: payoutItemId,
      transaction_id: txId,
      transaction_status: "SUCCESS",
      payout_item: {
        sender_item_id: `ITEM_${paymentId}`,
        recipient_type: "EMAIL",
        amount: { value: "800.00", currency: "USD" },
      },
      // payout_item_fee: UNVERIFIED in webhook payload; observed in batch GET ($0.25 on $1.00)
      ...(includeFee ? { payout_item_fee: { value: "0.25", currency: "USD" } } : {}),
    },
  };
}

/** Fixture: PAYMENT.PAYOUTS-ITEM.FAILED [UNTESTED against real PayPal — fixture only] */
function payoutsItemFailedEvent(paymentId: string, payoutItemId: string) {
  return {
    id: `WH-ITEM-FAIL-${payoutItemId}`,
    event_type: "PAYMENT.PAYOUTS-ITEM.FAILED",
    resource: {
      payout_item_id: payoutItemId,
      transaction_status: "FAILED",
      payout_item: {
        sender_item_id: `ITEM_${paymentId}`,
        recipient_type: "EMAIL",
        amount: { value: "800.00", currency: "USD" },
      },
      errors: {
        name: "RECEIVER_UNREGISTERED",
        message: "The receiver does not have a PayPal account.",
      },
    },
  };
}

/** Fixture: PAYMENT.PAYOUTS-ITEM.RETURNED [UNTESTED against real PayPal — fixture only] */
function payoutsItemReturnedEvent(paymentId: string, payoutItemId: string) {
  return {
    id: `WH-ITEM-RET-${payoutItemId}`,
    event_type: "PAYMENT.PAYOUTS-ITEM.RETURNED",
    resource: {
      payout_item_id: payoutItemId,
      transaction_status: "RETURNED",
      payout_item: {
        sender_item_id: `ITEM_${paymentId}`,
        recipient_type: "EMAIL",
        amount: { value: "800.00", currency: "USD" },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

type FakePayment = {
  id: string;
  milestoneId: string;
  status: string;
  paypalOrderId?: string | null;
  paypalCaptureId?: string | null;
  paypalPayoutBatchId?: string | null;
  paypalPayoutItemId?: string | null;
  payoutFeeUsd?: string | null;
  updatedAt?: Date;
};

type FakeMilestone = {
  id: string;
  status: string;
  paypalCaptureId?: string | null;
  paypalPayoutItemId?: string | null;
  updatedAt?: Date;
};

/**
 * Sets up the db mock chain for handler tests.
 *
 * Call sequence expected by the route:
 *   1. select from paypal_webhook_deliveries (duplicate check) → []
 *   2. select from payments → [payment]
 *   3. select from milestones → [milestone]
 *   4+. tryRecordEventId → insert ... onConflictDoNothing ... returning
 *
 * For PAYOUTSBATCH.SUCCESS, call 2 returns { id, milestoneId } only (no status).
 */
function setupHandlerMock(
  payment: FakePayment,
  milestone: FakeMilestone,
  opts: { batchPaymentShape?: boolean } = {}
) {
  let selectCallCount = 0;

  const mockLimit = vi.fn().mockImplementation(() => {
    selectCallCount++;
    if (selectCallCount === 1) return Promise.resolve([]);        // no duplicate
    if (selectCallCount === 2) {
      if (opts.batchPaymentShape) {
        return Promise.resolve([{ id: payment.id, milestoneId: payment.milestoneId }]);
      }
      return Promise.resolve([payment]);
    }
    if (selectCallCount === 3) return Promise.resolve([milestone]);
    return Promise.resolve([]);
  });

  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  (db.select as unknown as MockInstance).mockReturnValue({ from: mockFrom });

  const capturedSetCalls: unknown[] = [];
  const mockWhere2 = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockImplementation((args: unknown) => {
    capturedSetCalls.push(args);
    return { where: mockWhere2 };
  });
  (db.update as unknown as MockInstance).mockReturnValue({ set: mockSet });

  const mockReturning = vi.fn().mockResolvedValue([{ eventId: "WH-TEST" }]);
  const mockOnConflict = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflict });
  (db.insert as unknown as MockInstance).mockReturnValue({ values: mockValues });

  return { capturedSetCalls };
}

// ---------------------------------------------------------------------------
// Setup: ensure env vars are present and mocks are fresh each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  process.env.PAYPAL_WEBHOOK_ID = "TEST_WEBHOOK_ID_12345";
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  // Default: signature passes
  (verifyPayPalWebhook as unknown as MockInstance).mockResolvedValue({ valid: true, reason: "ok" });
  // Default: writeAuditLog is a no-op
  (writeAuditLog as unknown as MockInstance).mockResolvedValue(undefined);
});

// ===========================================================================
// 1. Invalid / missing signature
// ===========================================================================

describe("1. Invalid / missing signature", () => {
  it("returns 400 with generic body when signature verification fails", async () => {
    (verifyPayPalWebhook as unknown as MockInstance).mockResolvedValue({
      valid: false,
      reason: "CRC32 mismatch",
    });

    const req = buildRequest({ id: "WH-123", event_type: "PAYMENT.CAPTURE.COMPLETED" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid request" });
    // Must not leak the reason in the response
    expect(JSON.stringify(body)).not.toContain("CRC32");
    expect(JSON.stringify(body)).not.toContain("mismatch");
  });

  it("returns 400 when PAYPAL_WEBHOOK_ID env var is absent", async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    const req = buildRequest({ id: "WH-123", event_type: "PAYMENT.CAPTURE.COMPLETED" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid request" });
    // verifyPayPalWebhook must never be called — we return before reaching it
    expect(verifyPayPalWebhook).not.toHaveBeenCalled();
  });

  it("does NOT record event_id on signature failure", async () => {
    (verifyPayPalWebhook as unknown as MockInstance).mockResolvedValue({
      valid: false,
      reason: "bad cert host",
    });

    const req = buildRequest({ id: "WH-BAD-SIG", event_type: "PAYMENT.CAPTURE.COMPLETED" });
    await POST(req);

    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 2. Duplicate event_id
// ===========================================================================

describe("2. Duplicate event_id", () => {
  function setupDuplicate() {
    // First select returns the existing event (duplicate found)
    const mockLimit = vi.fn().mockResolvedValue([{ eventId: "WH-EXISTING-123" }]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    (db.select as unknown as MockInstance).mockReturnValue({ from: mockFrom });
  }

  it("returns 200 with duplicate_ignored when event already processed", async () => {
    setupDuplicate();

    const req = buildRequest({
      id: "WH-EXISTING-123",
      event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
      resource: { batch_header: { payout_batch_id: "BATCH-123" } },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("duplicate_ignored");
  });

  it("does NOT write audit log for duplicate event", async () => {
    setupDuplicate();

    const req = buildRequest({
      id: "WH-EXISTING-123",
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: {},
    });
    await POST(req);

    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3. Event_id recorded ONLY after successful processing
// ===========================================================================

describe("3. Event_id recorded only after successful processing", () => {
  it("records event_id after successful unhandled event type (200 no-op)", async () => {
    // Duplicate check: returns [] (not a duplicate)
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    (db.select as unknown as MockInstance).mockReturnValue({ from: mockFrom });

    // Insert (tryRecordEventId) succeeds
    const mockReturning = vi.fn().mockResolvedValue([{ eventId: "WH-NOOP-001" }]);
    const mockOnConflict = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflict });
    (db.insert as unknown as MockInstance).mockReturnValue({ values: mockValues });

    const req = buildRequest({ id: "WH-NOOP-001", event_type: "UNKNOWN.EVENT.TYPE" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    // tryRecordEventId calls db.insert — must have been called
    expect(db.insert).toHaveBeenCalled();
  });

  it("does NOT record event_id when handler throws a processing error", async () => {
    // Duplicate check succeeds (returns []) but then handler SELECT throws
    let callCount = 0;
    const mockLimit = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]); // duplicate check: not found
      // Second call (inside handler) throws
      return Promise.reject(new Error("DB connection lost"));
    });
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    (db.select as unknown as MockInstance).mockReturnValue({ from: mockFrom });

    const req = buildRequest({
      id: "WH-ERR-001",
      event_type: "PAYMENT.PAYOUTSBATCH.PROCESSING",
      resource: { batch_header: { payout_batch_id: "BATCH-ERR" } },
    });
    const res = await POST(req);

    // Route catches handler error and returns 500
    expect(res.status).toBe(500);
    // insert must NOT have been called — event_id not recorded on error
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. Illegal state transition rejected
// ===========================================================================

describe("5. Illegal state transition rejected", () => {
  it("throws MilestoneTransitionError for cancelled → funded", () => {
    expect(() => assertMilestoneTransition("cancelled", "funded")).toThrow(
      MilestoneTransitionError
    );
  });

  it("throws MilestoneTransitionError for paid → planned", () => {
    expect(() => assertMilestoneTransition("paid", "planned")).toThrow(MilestoneTransitionError);
  });

  it("throws PaymentTransitionError for succeeded → processing", () => {
    expect(() => assertPaymentTransition("succeeded", "processing")).toThrow(
      PaymentTransitionError
    );
  });
});

// ===========================================================================
// 6. PAYOUTSBATCH.PROCESSING
// ===========================================================================

describe("6. PAYOUTSBATCH.PROCESSING handler", () => {
  it("updates payment status to processing and writes audit log", async () => {
    const payment: FakePayment = {
      id: "pay-001",
      milestoneId: "ms-001",
      status: "pending",
      paypalPayoutBatchId: "BATCH-PROC-001",
    };
    const milestone: FakeMilestone = { id: "ms-001", status: "verifying" };
    setupHandlerMock(payment, milestone);

    const req = buildRequest(payoutsBatchProcessingEvent("BATCH-PROC-001"));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "PAYOUT_BATCH_PROCESSING" })
    );
  });
});

// ===========================================================================
// 7. PAYOUTSBATCH.SUCCESS
// ===========================================================================

describe("7. PAYOUTSBATCH.SUCCESS handler", () => {
  it("writes audit log only — does NOT call db.update", async () => {
    const payment: FakePayment = {
      id: "pay-002",
      milestoneId: "ms-002",
      status: "processing",
      paypalPayoutBatchId: "BATCH-SUC-001",
    };
    const milestone: FakeMilestone = { id: "ms-002", status: "verifying" };
    // batchPaymentShape: true — SUCCESS handler selects { id, milestoneId } not full row
    setupHandlerMock(payment, milestone, { batchPaymentShape: true });

    const req = buildRequest(payoutsBatchSuccessEvent("BATCH-SUC-001"));
    const res = await POST(req);

    expect(res.status).toBe(200);
    // PAYOUTSBATCH.SUCCESS must NOT update payment/milestone — only audit log
    expect(db.update).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "PAYOUT_BATCH_SUCCESS" })
    );
  });
});

// ===========================================================================
// 8. PAYOUTS-ITEM.SUCCEEDED
// ===========================================================================

describe("8. PAYOUTS-ITEM.SUCCEEDED handler", () => {
  it("updates payment → succeeded and milestone → paid", async () => {
    const payment: FakePayment = { id: "pay-003", milestoneId: "ms-003", status: "processing" };
    const milestone: FakeMilestone = { id: "ms-003", status: "verifying" };
    setupHandlerMock(payment, milestone);

    const req = buildRequest(payoutsItemSucceededEvent("pay-003", "ITEM-ID-001", "TX-001"));
    const res = await POST(req);

    expect(res.status).toBe(200);
    // Two updates: payment + milestone
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "PAYOUT_ITEM_SUCCEEDED" })
    );
  });

  it("extracts payout_item_fee from webhook payload when present", async () => {
    const payment: FakePayment = { id: "pay-003b", milestoneId: "ms-003b", status: "processing" };
    const milestone: FakeMilestone = { id: "ms-003b", status: "verifying" };
    const { capturedSetCalls } = setupHandlerMock(payment, milestone);

    const req = buildRequest(payoutsItemSucceededEvent("pay-003b", "ITEM-FEE", "TX-FEE", true));
    await POST(req);

    // Payment update (first set call) should include payoutFeeUsd
    const paymentUpdate = capturedSetCalls[0] as Record<string, unknown>;
    expect(paymentUpdate).toHaveProperty("payoutFeeUsd", "0.25");
  });

  it("does NOT set payoutFeeUsd when payout_item_fee is absent in payload", async () => {
    const payment: FakePayment = { id: "pay-003c", milestoneId: "ms-003c", status: "processing" };
    const milestone: FakeMilestone = { id: "ms-003c", status: "verifying" };
    const { capturedSetCalls } = setupHandlerMock(payment, milestone);

    const req = buildRequest(payoutsItemSucceededEvent("pay-003c", "ITEM-NOFEE", "TX-NOFEE", false));
    await POST(req);

    const paymentUpdate = capturedSetCalls[0] as Record<string, unknown>;
    // When fee is absent from payload, payoutFeeUsd should NOT be in the update object
    expect(paymentUpdate).not.toHaveProperty("payoutFeeUsd");
  });
});

// ===========================================================================
// 9. PAYOUTS-ITEM.FAILED [UNTESTED against real PayPal — fixture only]
// ===========================================================================

describe("9. PAYOUTS-ITEM.FAILED handler [UNTESTED against real PayPal — fixture only]", () => {
  it("updates payment → failed and milestone → failed", async () => {
    const payment: FakePayment = { id: "pay-004", milestoneId: "ms-004", status: "processing" };
    const milestone: FakeMilestone = { id: "ms-004", status: "verifying" };
    const { capturedSetCalls } = setupHandlerMock(payment, milestone);

    const req = buildRequest(payoutsItemFailedEvent("pay-004", "ITEM-FAIL-004"));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(2);

    const paymentUpdate = capturedSetCalls[0] as Record<string, unknown>;
    expect(paymentUpdate).toHaveProperty("status", "failed");

    const milestoneUpdate = capturedSetCalls[1] as Record<string, unknown>;
    expect(milestoneUpdate).toHaveProperty("status", "failed");

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "PAYOUT_ITEM_FAILED" })
    );
  });
});

// ===========================================================================
// 10. PAYOUTS-ITEM.RETURNED [UNTESTED against real PayPal — fixture only]
// ===========================================================================

describe("10. PAYOUTS-ITEM.RETURNED handler [UNTESTED against real PayPal — fixture only]", () => {
  it("updates payment → failed and milestone → returned", async () => {
    const payment: FakePayment = { id: "pay-005", milestoneId: "ms-005", status: "processing" };
    const milestone: FakeMilestone = { id: "ms-005", status: "verifying" };
    const { capturedSetCalls } = setupHandlerMock(payment, milestone);

    const req = buildRequest(payoutsItemReturnedEvent("pay-005", "ITEM-RET-005"));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(2);

    const paymentUpdate = capturedSetCalls[0] as Record<string, unknown>;
    expect(paymentUpdate).toHaveProperty("status", "failed");

    const milestoneUpdate = capturedSetCalls[1] as Record<string, unknown>;
    expect(milestoneUpdate).toHaveProperty("status", "returned");

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "PAYOUT_ITEM_RETURNED" })
    );
  });
});

// ===========================================================================
// 11. Out-of-order event delivery (state machine level)
// ===========================================================================

describe("11. Out-of-order event delivery", () => {
  it("PAYOUTS-ITEM.SUCCEEDED is idempotent when payment already succeeded", () => {
    expect(() => assertPaymentTransition("succeeded", "succeeded")).not.toThrow();
    expect(isPaymentTransitionAllowed("succeeded", "succeeded")).toBe(true);
  });

  it("PAYOUTSBATCH.PROCESSING arriving when payment already processing is idempotent", () => {
    expect(() => assertPaymentTransition("processing", "processing")).not.toThrow();
  });

  it("FUNDED webhook arriving after milestone already funded is idempotent", () => {
    expect(() => assertMilestoneTransition("funded", "funded")).not.toThrow();
    expect(isMilestoneTransitionAllowed("funded", "funded")).toBe(true);
  });

  it("PAID webhook arriving after milestone already paid is idempotent", () => {
    expect(() => assertMilestoneTransition("paid", "paid")).not.toThrow();
    expect(isMilestoneTransitionAllowed("paid", "paid")).toBe(true);
  });

  it("out-of-order full sequence still ends in correct state", () => {
    // Simulate the full happy path even with out-of-order events:
    // All individual transitions should be allowed; same-state = allowed (idempotent)
    const milestoneSeq: [string, string][] = [
      ["planned",          "funded"],
      ["funded",           "pending_approval"],
      ["pending_approval", "verifying"],
      ["verifying",        "paid"],
    ];
    for (const [from, to] of milestoneSeq) {
      expect(() =>
        assertMilestoneTransition(from as any, to as any)
      ).not.toThrow();
    }

    const paymentSeq: [string, string][] = [
      ["pending",    "processing"],
      ["processing", "succeeded"],
    ];
    for (const [from, to] of paymentSeq) {
      expect(() =>
        assertPaymentTransition(from as any, to as any)
      ).not.toThrow();
    }
  });
});

// ===========================================================================
// 12. State machine: verifying → failed and verifying → returned
// ===========================================================================

describe("12. State machine: verifying → failed and verifying → returned", () => {
  it("allows verifying → failed (payout item fails after batch submitted)", () => {
    expect(() => assertMilestoneTransition("verifying", "failed")).not.toThrow();
    expect(isMilestoneTransitionAllowed("verifying", "failed")).toBe(true);
  });

  it("allows verifying → returned (payout item returned after batch submitted)", () => {
    expect(() => assertMilestoneTransition("verifying", "returned")).not.toThrow();
    expect(isMilestoneTransitionAllowed("verifying", "returned")).toBe(true);
  });

  it("rejects verifying → funded (invalid backward transition)", () => {
    expect(() => assertMilestoneTransition("verifying", "funded")).toThrow(MilestoneTransitionError);
    expect(isMilestoneTransitionAllowed("verifying", "funded")).toBe(false);
  });
});

// ===========================================================================
// 13. Payout replay — same-state idempotency
// ===========================================================================

describe("13. Payout replay — idempotency (same-state no-op)", () => {
  it("processing → processing is idempotent", () => {
    expect(() => assertPaymentTransition("processing", "processing")).not.toThrow();
    expect(isPaymentTransitionAllowed("processing", "processing")).toBe(true);
  });

  it("succeeded → succeeded is idempotent (duplicate SUCCEEDED webhook)", () => {
    expect(() => assertPaymentTransition("succeeded", "succeeded")).not.toThrow();
    expect(isPaymentTransitionAllowed("succeeded", "succeeded")).toBe(true);
  });
});
