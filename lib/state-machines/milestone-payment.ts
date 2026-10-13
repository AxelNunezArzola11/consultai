/**
 * Milestone payment state machine — Phase 1
 *
 * States follow the payment flow lifecycle for a milestone:
 *   planned → funded → pending_approval → verifying → paid
 *   (plus failed, returned, disputed, cancelled terminal states)
 *
 * Mapping to Phase 1 step-1 naming:
 *   DRAFT                  = "planned"
 *   AWAITING_FUNDING       = "planned"  (same DB value — pre-payment)
 *   FUNDED_HELD_SIMULATED  = "funded"   (capture completed, held in platform account)
 *   PAYOUT_PENDING_APPROVAL= "pending_approval"
 *   PAYOUT_PROCESSING      = "verifying" (payout batch submitted, awaiting webhook)
 *   PAID                   = "paid"
 *   FAILED                 = "failed"
 *   RETURNED               = "returned"
 *
 * Transitions are enforced here. Callers that attempt an invalid transition
 * receive a MilestoneTransitionError (not a silent no-op or DB constraint error).
 *
 * Source: consultai-plan.md §7.2 Milestone / Payment State Machine
 */

export type MilestoneStatus =
  | "planned"
  | "funded"
  | "submitted"
  | "verifying"
  | "pending_approval"
  | "paid"
  | "disputed"
  | "cancelled"
  | "failed"
  | "returned";

export type PaymentStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "on_hold"
  | "returned";

function ms(...vals: MilestoneStatus[]): ReadonlySet<MilestoneStatus> {
  return new Set<MilestoneStatus>(vals);
}
function ps(...vals: PaymentStatus[]): ReadonlySet<PaymentStatus> {
  return new Set<PaymentStatus>(vals);
}

/** Allowed transitions: from → Set<to> */
const MILESTONE_TRANSITIONS: Record<MilestoneStatus, ReadonlySet<MilestoneStatus>> = {
  planned:          ms("funded", "cancelled"),
  funded:           ms("pending_approval", "submitted", "disputed", "cancelled"),
  submitted:        ms("verifying", "cancelled"),
  // verifying → failed/returned: payout item fails/returns after batch is submitted.
  // These are real terminal transitions driven by PAYOUTS-ITEM.FAILED / RETURNED webhooks.
  verifying:        ms("pending_approval", "submitted", "paid", "failed", "returned"),
  pending_approval: ms("verifying", "paid", "cancelled"),
  paid:             ms("disputed"),   // post-paid dispute possible
  disputed:         ms("paid", "cancelled"),
  cancelled:        ms(),              // terminal
  failed:           ms("planned"),     // allow retry from failed
  returned:         ms("planned"),     // allow retry from returned
};

/** Allowed transitions: from → Set<to> */
const PAYMENT_TRANSITIONS: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  pending:    ps("processing", "failed"),
  processing: ps("succeeded", "failed", "returned", "on_hold"),
  succeeded:  ps(),            // terminal
  failed:     ps("pending"),   // allow retry
  on_hold:    ps("processing", "failed"),
  returned:   ps("pending"),   // allow retry
};

export class MilestoneTransitionError extends Error {
  constructor(from: MilestoneStatus, to: MilestoneStatus) {
    super(
      `Invalid milestone transition: ${from} → ${to}. ` +
        `Allowed from ${from}: [${Array.from(MILESTONE_TRANSITIONS[from]).join(", ") || "none"}]`
    );
    this.name = "MilestoneTransitionError";
  }
}

export class PaymentTransitionError extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(
      `Invalid payment transition: ${from} → ${to}. ` +
        `Allowed from ${from}: [${Array.from(PAYMENT_TRANSITIONS[from]).join(", ") || "none"}]`
    );
    this.name = "PaymentTransitionError";
  }
}

/**
 * Asserts that the milestone transition from → to is allowed.
 * Throws MilestoneTransitionError if not.
 *
 * NOTE: idempotent same-state transitions (from === to) are silently allowed
 * — this handles out-of-order webhook delivery where the state is already correct.
 */
export function assertMilestoneTransition(
  from: MilestoneStatus,
  to: MilestoneStatus
): void {
  if (from === to) return; // idempotent
  if (!MILESTONE_TRANSITIONS[from].has(to)) {
    throw new MilestoneTransitionError(from, to);
  }
}

/**
 * Asserts that the payment transition from → to is allowed.
 * Throws PaymentTransitionError if not.
 *
 * Same-state transitions are silently allowed (idempotent webhook delivery).
 */
export function assertPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus
): void {
  if (from === to) return;
  if (!PAYMENT_TRANSITIONS[from].has(to)) {
    throw new PaymentTransitionError(from, to);
  }
}

/**
 * Returns true if this milestone transition is allowed (non-throwing variant).
 */
export function isMilestoneTransitionAllowed(
  from: MilestoneStatus,
  to: MilestoneStatus
): boolean {
  if (from === to) return true;
  return MILESTONE_TRANSITIONS[from].has(to);
}

/**
 * Returns true if this payment transition is allowed (non-throwing variant).
 */
export function isPaymentTransitionAllowed(
  from: PaymentStatus,
  to: PaymentStatus
): boolean {
  if (from === to) return true;
  return PAYMENT_TRANSITIONS[from].has(to);
}
