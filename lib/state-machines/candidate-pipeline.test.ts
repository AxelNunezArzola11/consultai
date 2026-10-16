/**
 * Candidate pipeline state machine tests — Phase 4
 */

import { describe, it, expect } from "vitest";
import {
  assertCandidateTransition,
  isCandidateTransitionAllowed,
  CandidateTransitionError,
  isCascadeTrigger,
  toCascadeReason,
  isTerminal,
  hasAcceptedNda,
  CASCADE_TRIGGER_STATUSES,
  TERMINAL_STATUSES,
  type CandidateStatus,
} from "@/lib/state-machines/candidate-pipeline";

describe("candidate pipeline — assertCandidateTransition", () => {
  it("allows the canonical happy path", () => {
    const path: CandidateStatus[] = [
      "found",
      "shortlisted",
      "nda_sent",
      "nda_signed",
      "booking_unlocked",
      "booked",
      "meeting_held",
      "selected",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(() =>
        assertCandidateTransition(path[i], path[i + 1])
      ).not.toThrow();
    }
  });

  it("allows idempotent same-state transitions", () => {
    const states: CandidateStatus[] = [
      "found",
      "nda_sent",
      "booked",
      "selected",
    ];
    for (const s of states) {
      expect(() => assertCandidateTransition(s, s)).not.toThrow();
    }
  });

  it("throws CandidateTransitionError for invalid transitions", () => {
    expect(() =>
      assertCandidateTransition("found", "booked")
    ).toThrowError(CandidateTransitionError);

    expect(() =>
      assertCandidateTransition("selected", "nda_sent")
    ).toThrowError(CandidateTransitionError);

    expect(() =>
      assertCandidateTransition("declined", "nda_sent")
    ).toThrowError(CandidateTransitionError);
  });

  it("allows rejection from any pre-selected state", () => {
    const rejectableStates: CandidateStatus[] = [
      "found",
      "shortlisted",
      "meeting_held",
    ];
    for (const s of rejectableStates) {
      expect(isCandidateTransitionAllowed(s, "rejected")).toBe(true);
    }
  });

  it("blocks transitions out of terminal states", () => {
    for (const terminal of TERMINAL_STATUSES) {
      if (terminal === "cascaded" || terminal === "rejected") continue;
      expect(isCandidateTransitionAllowed(terminal, "found")).toBe(false);
    }
  });

  it("allows NDA decline from NDA_SENT", () => {
    expect(isCandidateTransitionAllowed("nda_sent", "declined")).toBe(true);
  });

  it("allows INVALID_BOOKING from booked", () => {
    expect(isCandidateTransitionAllowed("booked", "invalid_booking")).toBe(true);
  });

  it("does NOT allow cascade trigger from INVALID_BOOKING (company must review)", () => {
    expect(isCascadeTrigger("invalid_booking")).toBe(false);
  });
});

describe("cascade trigger detection", () => {
  it("detects all four cascade triggers", () => {
    expect(isCascadeTrigger("declined")).toBe(true);
    expect(isCascadeTrigger("expired")).toBe(true);
    expect(isCascadeTrigger("cancelled")).toBe(true);
    expect(isCascadeTrigger("no_show")).toBe(true);
  });

  it("does not flag non-cascade states", () => {
    expect(isCascadeTrigger("selected")).toBe(false);
    expect(isCascadeTrigger("rejected")).toBe(false);
    expect(isCascadeTrigger("cascaded")).toBe(false);
    expect(isCascadeTrigger("invalid_booking")).toBe(false);
  });

  it("maps statuses to cascade reasons", () => {
    expect(toCascadeReason("declined")).toBe("DECLINED");
    expect(toCascadeReason("expired")).toBe("EXPIRED");
    expect(toCascadeReason("cancelled")).toBe("CANCELLED");
    expect(toCascadeReason("no_show")).toBe("NO_SHOW");
  });

  it("throws for non-cascade status", () => {
    expect(() => toCascadeReason("selected")).toThrow();
  });
});

describe("terminal state detection", () => {
  it("marks all terminal states correctly", () => {
    for (const t of TERMINAL_STATUSES) {
      expect(isTerminal(t)).toBe(true);
    }
  });

  it("does not mark active states as terminal", () => {
    const active: CandidateStatus[] = [
      "found",
      "shortlisted",
      "nda_sent",
      "nda_signed",
      "booking_unlocked",
      "booked",
      "meeting_held",
    ];
    for (const s of active) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe("NDA gate", () => {
  it("grants full brief access for NDA_SIGNED and beyond", () => {
    const granted: CandidateStatus[] = [
      "nda_signed",
      "booking_unlocked",
      "booked",
      "meeting_held",
      "selected",
    ];
    for (const s of granted) {
      expect(hasAcceptedNda(s)).toBe(true);
    }
  });

  it("denies full brief access before NDA_SIGNED", () => {
    const denied: CandidateStatus[] = [
      "found",
      "shortlisted",
      "nda_sent",
      "pending",
    ];
    for (const s of denied) {
      expect(hasAcceptedNda(s)).toBe(false);
    }
  });

  it("denies full brief access for terminal states", () => {
    const denied: CandidateStatus[] = [
      "declined",
      "expired",
      "cancelled",
      "no_show",
    ];
    for (const s of denied) {
      expect(hasAcceptedNda(s)).toBe(false);
    }
  });
});
