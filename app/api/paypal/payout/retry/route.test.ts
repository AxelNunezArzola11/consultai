/**
 * POST /api/paypal/payout/retry — failed-payout retry tests.
 *
 * A payout that failed at PayPal (payment `failed`, milestone `failed`)
 * can be re-issued: the route inserts a FRESH payment row (fresh PayPal
 * sender_batch_id / sender_item_id so the retry can't collide with the
 * failed attempt), resets the milestone to `funded` via the allowed
 * failed → planned → funded walk, and runs the normal approval-gated
 * payout executor against the new row.
 *
 * Mocked-db unit level: drizzle chains + executeDirectPayout are stubbed;
 * the session store is real (in-memory). No live database, no PayPal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/payments/direct-payout", () => ({
  executeDirectPayout: vi.fn(),
}));

import { POST } from "./route";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/db/audit";
import { executeDirectPayout } from "@/lib/payments/direct-payout";
import {
  createSessionCookie,
  registerUserAccount,
  resetAuthStoreForTests,
} from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
const insertMock = db.insert as unknown as ReturnType<typeof vi.fn>;
const updateMock = db.update as unknown as ReturnType<typeof vi.fn>;
const directPayoutMock = executeDirectPayout as unknown as ReturnType<
  typeof vi.fn
>;

/** Select chain resolving `rows` at the `.limit()` terminal. */
function selectRows(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

function retryReq(
  ip: string,
  body: unknown,
  sessionCookie?: string
): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": ip,
  };
  if (sessionCookie) headers.Cookie = sessionCookie;
  return new NextRequest("http://localhost:3000/api/paypal/payout/retry", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function sessionCookieFor(
  email: string,
  role: "admin" | "company",
  companyId: string | null
): Promise<string> {
  const reg = await registerUserAccount({
    email,
    name: "Test User",
    passwordHash: await hashPassword("TestPass2026!"),
    role,
    companyId,
    companyName: role === "company" ? "Test Co" : null,
    industry: null,
    companyWebsite: null,
    companySize: null,
    billingCountry: null,
    title: "Owner",
    githubHandle: null,
    portfolioUrl: null,
    skills: [],
    bio: null,
    hourlyRateUsd: null,
    availability: null,
    termsAcceptedAt: new Date().toISOString(),
  });
  if (!reg.user) throw new Error("registration failed in test setup");
  const { sessionCookie } = await createSessionCookie(reg.user);
  return sessionCookie.split(";")[0];
}

const FAILED_PAYMENT = {
  id: "pay-failed-1",
  milestoneId: "ms-1",
  candidateId: "cand-1",
  grossUsd: "1500.00",
  feeUsd: "58.50",
  netUsd: "1441.50",
  currency: "USD",
  paypalOrderId: "ORDER-1",
  paypalCaptureId: "CAPTURE-1",
  senderBatchId: "PAY_pay-failed-1",
  status: "failed",
  payoutFailureReason: "RECEIVER_UNREGISTERED: The receiver does not have a PayPal account.",
};

const FAILED_MILESTONE = {
  id: "ms-1",
  projectId: "proj-1",
  status: "failed",
  paypalPayoutBatchId: "BATCH-OLD",
  paypalPayoutItemId: "ITEM-OLD",
};

describe("POST /api/paypal/payout/retry", () => {
  const saved = {
    demo: process.env.DEMO_MODE,
    nodeEnv: process.env.NODE_ENV,
    roleSecret: process.env.ROLE_COOKIE_SECRET,
    sessionSecret: process.env.SESSION_COOKIE_SECRET,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEMO_MODE = "";
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "test";
    process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.SESSION_COOKIE_SECRET = "fedcba9876543210fedcba9876543210";
    resetAuthStoreForTests();
  });

  afterEach(() => {
    process.env.DEMO_MODE = saved.demo;
    process.env.NODE_ENV = saved.nodeEnv;
    if (saved.roleSecret === undefined) delete process.env.ROLE_COOKIE_SECRET;
    else process.env.ROLE_COOKIE_SECRET = saved.roleSecret;
    if (saved.sessionSecret === undefined)
      delete process.env.SESSION_COOKIE_SECRET;
    else process.env.SESSION_COOKIE_SECRET = saved.sessionSecret;
    resetAuthStoreForTests();
  });

  it("creates a fresh attempt row, resets the milestone, and issues the payout", async () => {
    const cookie = await sessionCookieFor("admin-retry@example.com", "admin", null);
    selectMock
      .mockReturnValueOnce(selectRows([FAILED_PAYMENT]))
      .mockReturnValueOnce(selectRows([FAILED_MILESTONE]));

    const capturedValues: unknown[] = [];
    insertMock.mockReturnValue({
      values: vi.fn((v: unknown) => {
        capturedValues.push(v);
        return Promise.resolve(undefined);
      }),
    });
    const capturedSet: unknown[] = [];
    updateMock.mockReturnValue({
      set: vi.fn((s: unknown) => {
        capturedSet.push(s);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });
    directPayoutMock.mockResolvedValue({
      status: "ok",
      batchId: "BATCH-NEW",
      batchStatus: "PENDING",
    });

    const res = await POST(
      retryReq("10.9.0.1", {
        paymentId: "pay-failed-1",
        recipientEmail: "fixed@example.com",
        note: "receiver fixed their account",
      }, cookie)
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      batchId: "BATCH-NEW",
      originalPaymentId: "pay-failed-1",
    });
    expect(typeof body.retryPaymentId).toBe("string");
    expect(body.retryPaymentId).not.toBe("pay-failed-1");

    // Fresh row: new id, new sender_batch_id, funds still held (processing)
    expect(insertMock).toHaveBeenCalledTimes(1);
    const values = capturedValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      id: body.retryPaymentId,
      milestoneId: "ms-1",
      candidateId: "cand-1",
      netUsd: "1441.50",
      paypalCaptureId: "CAPTURE-1",
      status: "processing",
    });
    expect(values.senderBatchId).not.toBe("PAY_pay-failed-1");
    expect(String(values.senderBatchId)).toMatch(/^PAY_retry_/);

    // Milestone reset to funded with stale payout ids cleared
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(capturedSet[0]).toMatchObject({
      status: "funded",
      paypalPayoutBatchId: null,
      paypalPayoutItemId: null,
    });

    // Executor runs against the NEW row through the normal gate
    expect(directPayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: body.retryPaymentId,
        recipientEmail: "fixed@example.com",
        bypass_approval: false,
      })
    );

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "PAYOUT_RETRY_INITIATED",
        payload: expect.objectContaining({
          originalPaymentId: "pay-failed-1",
          failureReason: FAILED_PAYMENT.payoutFailureReason,
        }),
      })
    );
  });

  it("passes through pending_approval with approvalId + retryPaymentId when the retry exceeds the threshold", async () => {
    // Contract the ApprovalCard "held" state relies on: a held retry must
    // return 200 (not an error) with the new approval id and the fresh
    // attempt row id so the UI can render "Pending Admin Approval" and the
    // admin can release it from the approvals queue without a reload.
    const cookie = await sessionCookieFor("admin-retry-held@example.com", "admin", null);
    selectMock
      .mockReturnValueOnce(selectRows([FAILED_PAYMENT]))
      .mockReturnValueOnce(selectRows([FAILED_MILESTONE]));

    insertMock.mockReturnValue({
      values: vi.fn(() => Promise.resolve(undefined)),
    });
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    });
    directPayoutMock.mockResolvedValue({
      status: "pending_approval",
      approvalId: "apv-held-1",
      message: "Amount $1441.50 exceeds threshold $500 — approval required",
    });

    const res = await POST(
      retryReq("10.9.0.6", {
        paymentId: "pay-failed-1",
        recipientEmail: "fixed@example.com",
      }, cookie)
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "pending_approval",
      approvalId: "apv-held-1",
      originalPaymentId: "pay-failed-1",
    });
    expect(typeof body.retryPaymentId).toBe("string");
    expect(body.retryPaymentId).not.toBe("pay-failed-1");
    expect(body.error).toBeUndefined();

    // The fresh attempt row is still created and the milestone reset runs
    // before the executor applies the threshold gate internally.
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(directPayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: body.retryPaymentId,
        bypass_approval: false,
      })
    );
  });

  it("returns 404 when the payment does not exist", async () => {
    const cookie = await sessionCookieFor("admin-retry-404@example.com", "admin", null);
    selectMock.mockReturnValueOnce(selectRows([]));

    const res = await POST(
      retryReq("10.9.0.2", { paymentId: "pay-missing", recipientEmail: "a@b.co" }, cookie)
    );

    expect(res.status).toBe(404);
    expect(directPayoutMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the payment is not failed/returned", async () => {
    const cookie = await sessionCookieFor("admin-retry-409@example.com", "admin", null);
    selectMock.mockReturnValueOnce(
      selectRows([{ ...FAILED_PAYMENT, status: "processing" }])
    );

    const res = await POST(
      retryReq("10.9.0.3", { paymentId: "pay-failed-1", recipientEmail: "a@b.co" }, cookie)
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain("only 'failed' or 'returned'");
    expect(directPayoutMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 403 when a company session retries another company's payment", async () => {
    const cookie = await sessionCookieFor("co-other@example.com", "company", "company-other");
    selectMock
      .mockReturnValueOnce(selectRows([FAILED_PAYMENT]))
      .mockReturnValueOnce(selectRows([FAILED_MILESTONE]))
      .mockReturnValueOnce(selectRows([{ companyId: "company-1" }]));

    const res = await POST(
      retryReq("10.9.0.4", { paymentId: "pay-failed-1", recipientEmail: "a@b.co" }, cookie)
    );

    expect(res.status).toBe(403);
    expect(directPayoutMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing recipient email", async () => {
    const cookie = await sessionCookieFor("admin-retry-400@example.com", "admin", null);

    const res = await POST(
      retryReq("10.9.0.5", { paymentId: "pay-failed-1" }, cookie)
    );

    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
