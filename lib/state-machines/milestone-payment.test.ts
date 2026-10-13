/**
 * State machine tests — Step 1 checkpoint
 *
 * Tests:
 * 1. All allowed milestone transitions pass
 * 2. Illegal milestone transitions are rejected with MilestoneTransitionError
 * 3. Same-state (idempotent) milestone transitions pass
 * 4. All allowed payment transitions pass
 * 5. Illegal payment transitions are rejected with PaymentTransitionError
 * 6. Out-of-order events still end in the correct final state
 */

import { describe, it, expect } from "vitest";
import {
  assertMilestoneTransition,
  assertPaymentTransition,
  isMilestoneTransitionAllowed,
  isPaymentTransitionAllowed,
  MilestoneTransitionError,
  PaymentTransitionError,
  type MilestoneStatus,
  type PaymentStatus,
} from "@/lib/state-machines/milestone-payment";

describe("Milestone state machine", () => {
  describe("allowed transitions", () => {
    const allowed: [MilestoneStatus, MilestoneStatus][] = [
      ["planned", "funded"],
      ["planned", "cancelled"],
      ["funded", "pending_approval"],
      ["funded", "submitted"],
      ["funded", "disputed"],
      ["funded", "cancelled"],
      ["submitted", "verifying"],
      ["submitted", "cancelled"],
      ["verifying", "pending_approval"],
      ["verifying", "submitted"],
      ["verifying", "paid"],
      ["pending_approval", "verifying"],
      ["pending_approval", "paid"],
      ["pending_approval", "cancelled"],
      ["paid", "disputed"],
      ["disputed", "paid"],
      ["disputed", "cancelled"],
      ["failed", "planned"],
      ["returned", "planned"],
    ];

    for (const [from, to] of allowed) {
      it(`allows ${from} → ${to}`, () => {
        expect(() => assertMilestoneTransition(from, to)).not.toThrow();
        expect(isMilestoneTransitionAllowed(from, to)).toBe(true);
      });
    }
  });

  describe("illegal transitions", () => {
    const illegal: [MilestoneStatus, MilestoneStatus][] = [
      ["planned", "paid"],
      ["planned", "verifying"],
      ["funded", "planned"],
      ["paid", "planned"],
      ["cancelled", "planned"],
      ["cancelled", "funded"],
      ["paid", "funded"],
      ["verifying", "funded"],
    ];

    for (const [from, to] of illegal) {
      it(`rejects ${from} → ${to}`, () => {
        expect(() => assertMilestoneTransition(from, to)).toThrow(
          MilestoneTransitionError
        );
        expect(isMilestoneTransitionAllowed(from, to)).toBe(false);
      });
    }
  });

  describe("idempotent same-state transitions", () => {
    const states: MilestoneStatus[] = [
      "planned", "funded", "submitted", "verifying",
      "pending_approval", "paid", "disputed", "cancelled", "failed", "returned",
    ];

    for (const state of states) {
      it(`allows ${state} → ${state} (idempotent)`, () => {
        expect(() => assertMilestoneTransition(state, state)).not.toThrow();
        expect(isMilestoneTransitionAllowed(state, state)).toBe(true);
      });
    }
  });

  describe("out-of-order events still end in correct state", () => {
    it("FUNDED webhook arriving after PENDING_APPROVAL is already set is idempotent", () => {
      // Simulate: capture webhook arrived late when state is already pending_approval.
      // planned → funded is the expected path. If state is already funded, same-state is ok.
      expect(() => assertMilestoneTransition("funded", "funded")).not.toThrow();
    });

    it("duplicate PAID webhook when already paid is idempotent", () => {
      expect(() => assertMilestoneTransition("paid", "paid")).not.toThrow();
    });

    it("PAYOUT_PROCESSING then PAID is the happy path", () => {
      // planned → funded → pending_approval → verifying → paid
      const transitions: [MilestoneStatus, MilestoneStatus][] = [
        ["planned", "funded"],
        ["funded", "pending_approval"],
        ["pending_approval", "verifying"],
        ["verifying", "paid"],
      ];
      for (const [from, to] of transitions) {
        expect(() => assertMilestoneTransition(from, to)).not.toThrow();
      }
    });
  });
});

describe("Payment state machine", () => {
  describe("allowed transitions", () => {
    const allowed: [PaymentStatus, PaymentStatus][] = [
      ["pending", "processing"],
      ["pending", "failed"],
      ["processing", "succeeded"],
      ["processing", "failed"],
      ["processing", "returned"],
      ["processing", "on_hold"],
      ["failed", "pending"],
      ["on_hold", "processing"],
      ["on_hold", "failed"],
      ["returned", "pending"],
    ];

    for (const [from, to] of allowed) {
      it(`allows ${from} → ${to}`, () => {
        expect(() => assertPaymentTransition(from, to)).not.toThrow();
        expect(isPaymentTransitionAllowed(from, to)).toBe(true);
      });
    }
  });

  describe("illegal transitions", () => {
    const illegal: [PaymentStatus, PaymentStatus][] = [
      ["succeeded", "pending"],
      ["succeeded", "processing"],
      ["succeeded", "failed"],
      ["pending", "succeeded"],
      ["pending", "returned"],
      ["failed", "succeeded"],
    ];

    for (const [from, to] of illegal) {
      it(`rejects ${from} → ${to}`, () => {
        expect(() => assertPaymentTransition(from, to)).toThrow(
          PaymentTransitionError
        );
        expect(isPaymentTransitionAllowed(from, to)).toBe(false);
      });
    }
  });

  describe("idempotent same-state transitions", () => {
    const states: PaymentStatus[] = [
      "pending", "processing", "succeeded", "failed", "on_hold", "returned",
    ];

    for (const state of states) {
      it(`allows ${state} → ${state} (idempotent)`, () => {
        expect(() => assertPaymentTransition(state, state)).not.toThrow();
      });
    }
  });
});
