/**
 * Dispute state machine — Phase 6
 *
 * Tracks the lifecycle of a PayPal dispute from the platform (merchant) perspective.
 *
 * States map to PayPal dispute_state values plus internal app states:
 *   open             — REQUIRED_ACTION / REQUIRED_OTHER_PARTY_ACTION (newly created)
 *   waiting_for_seller  — REQUIRED_ACTION (we must respond)
 *   waiting_for_buyer   — REQUIRED_OTHER_PARTY_ACTION (buyer must respond)
 *   under_review     — UNDER_PAYPAL_REVIEW
 *   escalated        — pre-arbitration / arbitration
 *   resolved         — RESOLVED (in buyer or seller favor)
 *   closed           — terminal — APPEALABLE expired or other terminal state
 *
 * Evidence submission status (separate from dispute status):
 *   not_submitted → submitted  (idempotent — once submitted, never resubmit)
 *   not_submitted → failed     (submission attempt failed — retry allowed)
 *   failed → submitted         (retry succeeded)
 *
 * Hard rule: evidence is submitted at most once.
 * assertEvidenceNotSubmitted() must be called before any evidence submission attempt.
 *
 * Sources:
 *   consultai-plan.md §6.5 Custom dispute tools
 *   PayPal Disputes API: https://developer.paypal.com/docs/api/customer-disputes/v1/
 */

export type DisputeStatus =
  | "open"
  | "waiting_for_seller"
  | "waiting_for_buyer"
  | "under_review"
  | "escalated"
  | "resolved"
  | "closed";

export type DisputeEvidenceStatus =
  | "not_submitted"
  | "submitted"
  | "failed";

function ds(...vals: DisputeStatus[]): ReadonlySet<DisputeStatus> {
  return new Set<DisputeStatus>(vals);
}

/** Allowed transitions: from → Set<to> */
const DISPUTE_TRANSITIONS: Record<DisputeStatus, ReadonlySet<DisputeStatus>> = {
  open:                ds("waiting_for_seller", "waiting_for_buyer", "under_review", "escalated", "resolved", "closed"),
  waiting_for_seller:  ds("waiting_for_buyer", "under_review", "escalated", "resolved", "closed"),
  waiting_for_buyer:   ds("waiting_for_seller", "under_review", "escalated", "resolved", "closed"),
  under_review:        ds("waiting_for_seller", "waiting_for_buyer", "escalated", "resolved", "closed"),
  escalated:           ds("resolved", "closed"),
  resolved:            ds(),   // terminal
  closed:              ds(),   // terminal
};

/** Allowed evidence status transitions */
const EVIDENCE_TRANSITIONS: Record<DisputeEvidenceStatus, ReadonlySet<DisputeEvidenceStatus>> = {
  not_submitted: new Set<DisputeEvidenceStatus>(["submitted", "failed"]),
  submitted:     new Set<DisputeEvidenceStatus>([]),     // terminal — no resubmission
  failed:        new Set<DisputeEvidenceStatus>(["submitted"]),
};

export class DisputeTransitionError extends Error {
  constructor(from: DisputeStatus, to: DisputeStatus) {
    super(
      `Invalid dispute transition: ${from} → ${to}. ` +
        `Allowed from ${from}: [${Array.from(DISPUTE_TRANSITIONS[from]).join(", ") || "none"}]`
    );
    this.name = "DisputeTransitionError";
  }
}

export class DisputeEvidenceAlreadySubmittedError extends Error {
  constructor() {
    super(
      "Evidence has already been submitted for this dispute. " +
        "Idempotency rule: evidence must be submitted at most once."
    );
    this.name = "DisputeEvidenceAlreadySubmittedError";
  }
}

/**
 * Asserts that the dispute transition from → to is allowed.
 * Throws DisputeTransitionError if not.
 * Same-state transitions are silently allowed (idempotent webhook delivery).
 */
export function assertDisputeTransition(from: DisputeStatus, to: DisputeStatus): void {
  if (from === to) return; // idempotent
  if (!DISPUTE_TRANSITIONS[from].has(to)) {
    throw new DisputeTransitionError(from, to);
  }
}

/**
 * Returns true if the dispute transition from → to is allowed (non-throwing variant).
 */
export function isDisputeTransitionAllowed(from: DisputeStatus, to: DisputeStatus): boolean {
  if (from === to) return true;
  return DISPUTE_TRANSITIONS[from].has(to);
}

/**
 * Asserts that evidence has NOT yet been submitted.
 * Throws DisputeEvidenceAlreadySubmittedError if status is "submitted".
 * This is the idempotency guard — call before any provideEvidence attempt.
 */
export function assertEvidenceNotSubmitted(status: DisputeEvidenceStatus): void {
  if (status === "submitted") {
    throw new DisputeEvidenceAlreadySubmittedError();
  }
}

/**
 * Maps a PayPal dispute_state string to our DisputeStatus enum.
 * Unknown values return "open" as a safe default.
 */
export function paypalStateToDisputeStatus(paypalState: string): DisputeStatus {
  switch (paypalState) {
    case "REQUIRED_ACTION":              return "waiting_for_seller";
    case "REQUIRED_OTHER_PARTY_ACTION":  return "waiting_for_buyer";
    case "UNDER_PAYPAL_REVIEW":          return "under_review";
    case "RESOLVED":                     return "resolved";
    case "APPEALABLE":                   return "closed";
    case "OPEN_INQUIRIES":               return "open";
    default:                             return "open";
  }
}
