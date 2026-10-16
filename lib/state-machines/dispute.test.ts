/**
 * Dispute state machine tests — Phase 6
 *
 * Tests:
 * 1. All allowed dispute status transitions pass
 * 2. Illegal dispute status transitions are rejected with DisputeTransitionError
 * 3. Same-state (idempotent) transitions pass
 * 4. paypalStateToDisputeStatus maps known PayPal states correctly
 * 5. paypalStateToDisputeStatus returns "open" for unknown values
 * 6. assertEvidenceNotSubmitted throws when status is "submitted"
 * 7. assertEvidenceNotSubmitted does NOT throw for "not_submitted" or "failed"
 * 8. isDisputeTransitionAllowed returns false for illegal transitions
 * 9. resolved and closed are terminal — no transitions allowed from them
 */

import { describe, it, expect } from "vitest";
import {
  assertDisputeTransition,
  isDisputeTransitionAllowed,
  assertEvidenceNotSubmitted,
  paypalStateToDisputeStatus,
  DisputeTransitionError,
  DisputeEvidenceAlreadySubmittedError,
  type DisputeStatus,
  type DisputeEvidenceStatus,
} from "@/lib/state-machines/dispute";

describe("Dispute state machine", () => {
  describe("1. Allowed transitions pass", () => {
    const allowed: [DisputeStatus, DisputeStatus][] = [
      ["open", "waiting_for_seller"],
      ["open", "waiting_for_buyer"],
      ["open", "under_review"],
      ["open", "escalated"],
      ["open", "resolved"],
      ["open", "closed"],
      ["waiting_for_seller", "waiting_for_buyer"],
      ["waiting_for_seller", "under_review"],
      ["waiting_for_seller", "escalated"],
      ["waiting_for_seller", "resolved"],
      ["waiting_for_seller", "closed"],
      ["waiting_for_buyer", "waiting_for_seller"],
      ["waiting_for_buyer", "under_review"],
      ["waiting_for_buyer", "escalated"],
      ["waiting_for_buyer", "resolved"],
      ["waiting_for_buyer", "closed"],
      ["under_review", "waiting_for_seller"],
      ["under_review", "waiting_for_buyer"],
      ["under_review", "escalated"],
      ["under_review", "resolved"],
      ["under_review", "closed"],
      ["escalated", "resolved"],
      ["escalated", "closed"],
    ];

    for (const [from, to] of allowed) {
      it(`allows ${from} → ${to}`, () => {
        expect(() => assertDisputeTransition(from, to)).not.toThrow();
        expect(isDisputeTransitionAllowed(from, to)).toBe(true);
      });
    }
  });

  describe("2. Illegal transitions throw DisputeTransitionError", () => {
    const illegal: [DisputeStatus, DisputeStatus][] = [
      ["resolved", "open"],
      ["resolved", "waiting_for_seller"],
      ["closed", "open"],
      ["closed", "resolved"],
    ];

    for (const [from, to] of illegal) {
      it(`rejects ${from} → ${to}`, () => {
        expect(() => assertDisputeTransition(from, to)).toThrow(DisputeTransitionError);
        expect(isDisputeTransitionAllowed(from, to)).toBe(false);
      });
    }
  });

  describe("3. Same-state transitions are idempotent", () => {
    const states: DisputeStatus[] = [
      "open", "waiting_for_seller", "waiting_for_buyer",
      "under_review", "escalated", "resolved", "closed",
    ];

    for (const s of states) {
      it(`${s} → ${s} is a no-op`, () => {
        expect(() => assertDisputeTransition(s, s)).not.toThrow();
        expect(isDisputeTransitionAllowed(s, s)).toBe(true);
      });
    }
  });

  describe("4. paypalStateToDisputeStatus maps known PayPal states", () => {
    it("REQUIRED_ACTION → waiting_for_seller", () => {
      expect(paypalStateToDisputeStatus("REQUIRED_ACTION")).toBe("waiting_for_seller");
    });
    it("REQUIRED_OTHER_PARTY_ACTION → waiting_for_buyer", () => {
      expect(paypalStateToDisputeStatus("REQUIRED_OTHER_PARTY_ACTION")).toBe("waiting_for_buyer");
    });
    it("UNDER_PAYPAL_REVIEW → under_review", () => {
      expect(paypalStateToDisputeStatus("UNDER_PAYPAL_REVIEW")).toBe("under_review");
    });
    it("RESOLVED → resolved", () => {
      expect(paypalStateToDisputeStatus("RESOLVED")).toBe("resolved");
    });
    it("APPEALABLE → closed", () => {
      expect(paypalStateToDisputeStatus("APPEALABLE")).toBe("closed");
    });
    it("OPEN_INQUIRIES → open", () => {
      expect(paypalStateToDisputeStatus("OPEN_INQUIRIES")).toBe("open");
    });
  });

  describe("5. paypalStateToDisputeStatus returns 'open' for unknown values", () => {
    it("unknown string → open", () => {
      expect(paypalStateToDisputeStatus("SOME_FUTURE_STATE")).toBe("open");
      expect(paypalStateToDisputeStatus("")).toBe("open");
    });
  });

  describe("6. Evidence idempotency guard — assertEvidenceNotSubmitted", () => {
    it("throws when status is 'submitted'", () => {
      expect(() => assertEvidenceNotSubmitted("submitted")).toThrow(
        DisputeEvidenceAlreadySubmittedError
      );
    });

    it("does NOT throw for 'not_submitted'", () => {
      expect(() => assertEvidenceNotSubmitted("not_submitted")).not.toThrow();
    });

    it("does NOT throw for 'failed' (retry allowed)", () => {
      expect(() => assertEvidenceNotSubmitted("failed")).not.toThrow();
    });
  });

  describe("7. Terminal states have no outgoing transitions", () => {
    const terminal: DisputeStatus[] = ["resolved", "closed"];
    const targets: DisputeStatus[] = [
      "open", "waiting_for_seller", "waiting_for_buyer",
      "under_review", "escalated", "resolved", "closed",
    ];

    for (const from of terminal) {
      for (const to of targets) {
        if (from === to) continue; // same-state is always allowed
        it(`${from} → ${to} is NOT allowed`, () => {
          expect(isDisputeTransitionAllowed(from, to)).toBe(false);
        });
      }
    }
  });
});
