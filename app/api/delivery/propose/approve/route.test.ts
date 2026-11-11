/**
 * POST /api/delivery/propose/approve — payout retry tests.
 *
 * Regression coverage for the stuck-payout bug: a past approval recorded
 * its decision while the payout trigger failed (it selected a stale
 * `pending` payment row), leaving the milestone in `verifying` with no
 * batch and no webhook ever coming. Re-clicking Approve on an
 * already-approved proposal now retries ONLY the trigger against the
 * eligible payment — and never re-issues when a batch already exists.
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
import { executeDirectPayout } from "@/lib/payments/direct-payout";
import {
  createSessionCookie,
  registerUserAccount,
  resetAuthStoreForTests,
} from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
const directPayoutMock = executeDirectPayout as unknown as ReturnType<
  typeof vi.fn
>;

/** Select chain resolving `rows` for both `.limit()` and `.orderBy()` terminals. */
function selectRows(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
        orderBy: async () => rows,
      }),
    }),
  };
}

function approveReq(
  ip: string,
  body: unknown,
  sessionCookie?: string
): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": ip,
  };
  if (sessionCookie) headers.Cookie = sessionCookie;
  return new NextRequest(
    "http://localhost:3000/api/delivery/propose/approve",
    { method: "POST", headers, body: JSON.stringify(body) }
  );
}

async function companySessionCookie(
  email: string,
  companyId: string
): Promise<string> {
  const reg = await registerUserAccount({
    email,
    name: "Company Owner",
    passwordHash: await hashPassword("CompanyPass2026!"),
    role: "company",
    companyId,
    companyName: "Test Co",
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

const PROPOSAL = {
  id: "prop-1",
  milestoneId: "ms-1",
  runId: "run-1",
  status: "approved",
  boundHeadSha: "abc123",
  amountUsd: "500.00",
};

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pmt-1",
    milestoneId: "ms-1",
    status: "processing",
    netUsd: "482.06",
    senderBatchId: "PAY_pmt-1",
    paypalPayoutBatchId: null,
    updatedAt: new Date("2026-11-10T02:12:00Z"),
    ...overrides,
  };
}

describe("POST /api/delivery/propose/approve — payout retry", () => {
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

  /** Order: proposal → milestone → project → payments. */
  function mockRetryReads(payments: unknown[]) {
    selectMock
      .mockReturnValueOnce(selectRows([PROPOSAL]))
      .mockReturnValueOnce(selectRows([{ projectId: "proj-1" }]))
      .mockReturnValueOnce(selectRows([{ companyId: "company-1" }]))
      .mockReturnValueOnce(selectRows(payments));
  }

  it("retries the trigger against the ELIGIBLE payment (skips stale pending rows)", async () => {
    const cookie = await companySessionCookie("co-retry@example.com", "company-1");
    // Stale pending row FIRST — the old LIMIT 1 lookup paid this one.
    mockRetryReads([
      paymentRow({ id: "pmt-stale", status: "pending", netUsd: null }),
      paymentRow({ id: "pmt-real", status: "processing" }),
    ]);
    directPayoutMock.mockResolvedValue({ status: "ok", batchId: "BATCH-NEW" });

    const res = await POST(
      approveReq(
        "10.2.0.1",
        {
          proposalId: "prop-1",
          decision: "approved",
          recipientEmail: "freelancer@example.com",
        },
        cookie
      )
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      decision: "approved",
      payoutRetried: true,
    });
    expect(body.payout).toMatchObject({ status: "ok" });
    expect(directPayoutMock).toHaveBeenCalledTimes(1);
    expect(directPayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pmt-real" })
    );
  });

  it("never re-issues when a batch already exists (read-only no-op)", async () => {
    const cookie = await companySessionCookie("co-noop@example.com", "company-1");
    mockRetryReads([
      paymentRow({ id: "pmt-1", paypalPayoutBatchId: "BATCH-OLD" }),
    ]);

    const res = await POST(
      approveReq(
        "10.2.0.2",
        {
          proposalId: "prop-1",
          decision: "approved",
          recipientEmail: "freelancer@example.com",
        },
        cookie
      )
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ payoutRetried: true });
    expect(body.payout).toMatchObject({
      status: "already_issued",
      batchId: "BATCH-OLD",
    });
    expect(directPayoutMock).not.toHaveBeenCalled();
  });

  it("reports an explicit skip when no payment is eligible", async () => {
    const cookie = await companySessionCookie("co-skip@example.com", "company-1");
    mockRetryReads([
      paymentRow({ id: "pmt-stale", status: "pending", netUsd: null }),
    ]);

    const res = await POST(
      approveReq(
        "10.2.0.3",
        {
          proposalId: "prop-1",
          decision: "approved",
          recipientEmail: "freelancer@example.com",
        },
        cookie
      )
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ payoutRetried: true });
    expect(body.payout).toMatchObject({ status: "skipped" });
    expect(directPayoutMock).not.toHaveBeenCalled();
  });
});
