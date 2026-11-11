/**
 * Tests — payout trigger payment selection.
 *
 * Regression coverage for the stuck-payout bug: with several payment rows
 * per milestone, an unfiltered LIMIT 1 lookup selected a stale `pending`
 * row, the payout executor rejected it, and no payout was ever issued —
 * leaving the milestone in `verifying` with no batch and no webhook.
 *
 * Pure unit tests: no database, no network, no PayPal.
 */

import { describe, it, expect } from "vitest";
import {
  isPayoutIssued,
  selectPayoutEligiblePayment,
} from "./payout-trigger";

function row(
  id: string,
  status: string,
  updatedAt: string,
  paypalPayoutBatchId: string | null = null
) {
  return { id, status, updatedAt: new Date(updatedAt), paypalPayoutBatchId };
}

describe("selectPayoutEligiblePayment", () => {
  it("returns null when no rows exist", () => {
    expect(selectPayoutEligiblePayment([])).toBeNull();
  });

  it("returns null when only ineligible rows exist (never picks pending)", () => {
    const rows = [
      row("pmt-stale", "pending", "2026-11-09T20:10:00Z"),
      row("pmt-failed", "failed", "2026-11-09T21:00:00Z"),
    ];
    expect(selectPayoutEligiblePayment(rows)).toBeNull();
  });

  it("skips a stale pending row in favor of the processing row", () => {
    // Deliberately pending-first: row order must not matter.
    const rows = [
      row("pmt-stale", "pending", "2026-11-09T20:10:00Z"),
      row("pmt-real", "processing", "2026-11-10T02:12:00Z"),
    ];
    expect(selectPayoutEligiblePayment(rows)?.id).toBe("pmt-real");
  });

  it("prefers processing over on_hold", () => {
    const rows = [
      row("pmt-hold", "on_hold", "2026-11-10T03:00:00Z"),
      row("pmt-proc", "processing", "2026-11-10T01:00:00Z"),
    ];
    expect(selectPayoutEligiblePayment(rows)?.id).toBe("pmt-proc");
  });

  it("picks the newest row within the same status", () => {
    const rows = [
      row("pmt-old", "processing", "2026-11-09T01:00:00Z"),
      row("pmt-new", "processing", "2026-11-10T01:00:00Z"),
    ];
    expect(selectPayoutEligiblePayment(rows)?.id).toBe("pmt-new");
  });

  it("accepts on_hold when no processing row exists", () => {
    const rows = [row("pmt-hold", "on_hold", "2026-11-10T01:00:00Z")];
    expect(selectPayoutEligiblePayment(rows)?.id).toBe("pmt-hold");
  });
});

describe("isPayoutIssued", () => {
  it("is true only when a batch id is recorded", () => {
    expect(isPayoutIssued(row("a", "processing", "2026-11-10T01:00:00Z", "BATCH-1"))).toBe(true);
    expect(isPayoutIssued(row("b", "processing", "2026-11-10T01:00:00Z", null))).toBe(false);
    expect(isPayoutIssued(row("c", "processing", "2026-11-10T01:00:00Z", ""))).toBe(false);
  });
});
