/**
 * Security regression tests for POST /api/paypal/payout/approve.
 *
 * Payout approval moves real money, so the gate must reject
 * unauthenticated / freelancer / role-header-forged callers with 403
 * BEFORE any approval lookup, state-machine transition, or PayPal call.
 * In offline demo mode the route honestly reports demo_mode_unavailable
 * (503) instead of a simulated money movement.
 *
 * The cross-company live test (Company A cannot approve Company B's payout)
 * needs a live test database + PayPal sandbox and is left as an honest
 * non-run skip: TEST_DATABASE_URL is missing in this environment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as approvePOST } from "./route";

function approveReq(init: { cookie?: string; roleHeader?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.roleHeader) headers["X-ConsultAI-Role"] = init.roleHeader;
  return new NextRequest("http://localhost:3000/api/paypal/payout/approve", {
    method: "POST",
    headers,
    body: JSON.stringify({
      approvalId: "synthetic-approval-1",
      recipientEmail: "payee@consultai.test",
    }),
  });
}

describe("POST /api/paypal/payout/approve auth gate (live guards)", () => {
  beforeEach(() => {
    // Live-guard mode: guards run before any DB access, so no DATABASE_URL
    // is needed for these 403 assertions. Live mode requires an explicit
    // signing secret (no ephemeral demo fallback).
    process.env.DEMO_MODE = "";
    process.env.ROLE_COOKIE_SECRET = "test-secret-0123456789abcdef-payout-gate";
  });

  it("unauthenticated caller → 403 before any approval/PayPal access", async () => {
    const res = await approvePOST(approveReq());
    expect(res.status).toBe(403);
  });

  it("freelancer role → 403", async () => {
    const freelancerCookie = (await signRoleCookie("freelancer")).split(";")[0];
    const res = await approvePOST(approveReq({ cookie: freelancerCookie }));
    expect(res.status).toBe(403);
  });

  it("X-ConsultAI-Role header does not authorize a payout approval", async () => {
    const forged = await approvePOST(approveReq({ roleHeader: "admin" }));
    expect(forged.status).toBe(403);

    const freelancerCookie = (await signRoleCookie("freelancer")).split(";")[0];
    const escalated = await approvePOST(
      approveReq({ cookie: freelancerCookie, roleHeader: "admin" })
    );
    expect(escalated.status).toBe(403);
  });

  it("live session-less company cookie → 403 missing_company_context (D.3)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await approvePOST(approveReq({ cookie: companyCookie }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("missing_company_context");
  });

  it("offline demo mode honestly reports unavailable (never a simulated payout)", async () => {
    process.env.DEMO_MODE = "true";
    try {
      const companyCookie = (await signRoleCookie("company")).split(";")[0];
      const res = await approvePOST(approveReq({ cookie: companyCookie }));
      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("demo_mode_unavailable");
    } finally {
      process.env.DEMO_MODE = "";
    }
  });

  // HONEST NON-RUN (BLOCKER): proving Company A cannot approve Company B's
  // payout end-to-end requires a live isolated test database
  // (TEST_DATABASE_URL — missing in this environment) plus PayPal sandbox
  // credentials. The live branch DOES scope approvals to the session company
  // (verified by code inspection), but that path is unclaimed until the
  // harness exists. Never mocked into a pass.
  it.skip("Company A cannot approve Company B's payout (BLOCKER: TEST_DATABASE_URL missing)", async () => {
    expect(true).toBe(false);
  });
});
