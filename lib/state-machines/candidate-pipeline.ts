/**
 * Candidate pipeline state machine — Phase 4
 *
 * Full pipeline per consultai-plan.md §4 Phase 4 spec:
 *
 *   FOUND → SHORTLISTED → NDA_SENT → NDA_SIGNED → BOOKING_UNLOCKED
 *         → BOOKED → MEETING_HELD → SELECTED
 *
 * Terminal / side states:
 *   DECLINED, EXPIRED, CANCELLED, NO_SHOW, INVALID_BOOKING, REJECTED, CASCADED
 *
 * Legacy status values from Phase 1 ("pending", "scheduled") are mapped to
 * their Phase 4 equivalents in the DB but remain in the union type for compat.
 *
 * Transitions are enforced here. Callers that attempt an invalid transition
 * receive a CandidateTransitionError (not a silent no-op or DB constraint error).
 * Same-state transitions are silently allowed (idempotent webhook delivery).
 *
 * Source: consultai-plan.md §4 Phase 4 — Candidate Pipeline & State Machine
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CandidateStatus =
  // Phase 4 pipeline (canonical)
  | "found"
  | "shortlisted"
  | "nda_sent"
  | "nda_signed"
  | "booking_unlocked"
  | "booked"
  | "meeting_held"
  | "selected"
  // Terminal / side states
  | "declined"
  | "expired"
  | "cancelled"
  | "no_show"
  | "invalid_booking"
  | "rejected"
  | "cascaded"
  // Phase 1 legacy (kept for DB compat)
  | "pending"
  | "scheduled";

/** Reasons that trigger a cascade to the next ranked candidate */
export type CascadeReason = "EXPIRED" | "DECLINED" | "CANCELLED" | "NO_SHOW";

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

function cs(...vals: CandidateStatus[]): ReadonlySet<CandidateStatus> {
  return new Set<CandidateStatus>(vals);
}

/**
 * Allowed transitions: from → Set<to>
 *
 * Terminal states map to empty sets (no exit).
 * "pending" (Phase 1 legacy) behaves like "found".
 * "scheduled" (Phase 1 legacy) behaves like "booked".
 */
const CANDIDATE_TRANSITIONS: Record<CandidateStatus, ReadonlySet<CandidateStatus>> = {
  // Phase 1 legacy
  pending:         cs("found", "shortlisted", "nda_sent", "rejected"),
  scheduled:       cs("meeting_held", "no_show", "cancelled"),

  // Phase 4 pipeline
  found:           cs("shortlisted", "rejected"),
  shortlisted:     cs("nda_sent", "rejected"),
  nda_sent:        cs("nda_signed", "declined", "expired"),
  nda_signed:      cs("booking_unlocked"),
  booking_unlocked: cs("booked", "cancelled"),
  booked:          cs("meeting_held", "no_show", "cancelled", "invalid_booking"),
  meeting_held:    cs("selected", "rejected"),
  selected:        cs(), // terminal — project moves forward

  // Side / terminal states — some allow cascade recovery
  declined:        cs(), // terminal; triggers cascade
  expired:         cs(), // terminal; triggers cascade
  cancelled:       cs(), // terminal; triggers cascade
  no_show:         cs(), // terminal; triggers cascade
  invalid_booking: cs(), // terminal; no cascade — company must review
  rejected:        cs(), // terminal
  cascaded:        cs(), // terminal — the candidate was replaced by next ranked
};

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class CandidateTransitionError extends Error {
  constructor(from: CandidateStatus, to: CandidateStatus) {
    const allowed = Array.from(CANDIDATE_TRANSITIONS[from]).join(", ") || "none";
    super(
      `Invalid candidate transition: ${from} → ${to}. ` +
        `Allowed from ${from}: [${allowed}]`
    );
    this.name = "CandidateTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Core assertion helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that the candidate transition from → to is allowed.
 * Throws CandidateTransitionError if not.
 * Same-state transitions (from === to) are silently allowed (idempotent delivery).
 */
export function assertCandidateTransition(
  from: CandidateStatus,
  to: CandidateStatus
): void {
  if (from === to) return; // idempotent
  if (!CANDIDATE_TRANSITIONS[from]?.has(to)) {
    throw new CandidateTransitionError(from, to);
  }
}

/**
 * Returns true if the candidate transition is allowed (non-throwing variant).
 */
export function isCandidateTransitionAllowed(
  from: CandidateStatus,
  to: CandidateStatus
): boolean {
  if (from === to) return true;
  return CANDIDATE_TRANSITIONS[from]?.has(to) ?? false;
}

// ---------------------------------------------------------------------------
// Cascade helpers
// ---------------------------------------------------------------------------

/** Status values that trigger a cascade to the next ranked candidate */
export const CASCADE_TRIGGER_STATUSES = new Set<CandidateStatus>([
  "declined",
  "expired",
  "cancelled",
  "no_show",
]);

/**
 * Returns true if transitioning to this status should trigger cascade logic.
 * Note: INVALID_BOOKING does NOT trigger cascade — company must review manually.
 */
export function isCascadeTrigger(status: CandidateStatus): boolean {
  return CASCADE_TRIGGER_STATUSES.has(status);
}

/**
 * Returns the cascade reason string for a triggering status.
 * Throws if the status is not a cascade trigger.
 */
export function toCascadeReason(status: CandidateStatus): CascadeReason {
  switch (status) {
    case "declined": return "DECLINED";
    case "expired":  return "EXPIRED";
    case "cancelled": return "CANCELLED";
    case "no_show":  return "NO_SHOW";
    default:
      throw new Error(`Status ${status} is not a cascade trigger`);
  }
}

// ---------------------------------------------------------------------------
// Terminal state helpers
// ---------------------------------------------------------------------------

/** Status values that are terminal (no further transitions allowed) */
export const TERMINAL_STATUSES = new Set<CandidateStatus>([
  "selected",
  "declined",
  "expired",
  "cancelled",
  "no_show",
  "invalid_booking",
  "rejected",
  "cascaded",
]);

export function isTerminal(status: CandidateStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// NDA-gate helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the candidate has accepted the NDA (i.e. full brief access).
 * The source of truth is always the DATABASE — this helper is for display logic only.
 * Never trust client-side state for access control.
 */
export function hasAcceptedNda(status: CandidateStatus): boolean {
  return (
    status === "nda_signed" ||
    status === "booking_unlocked" ||
    status === "booked" ||
    status === "meeting_held" ||
    status === "selected"
  );
}
