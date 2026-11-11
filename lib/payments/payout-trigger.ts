/**
 * Payout trigger payment selection.
 *
 * A milestone can accumulate several payment rows (e.g. a stale `pending`
 * row from an earlier funding attempt alongside the real `processing` row
 * from the completed capture). Picking "the" payment with an unfiltered
 * LIMIT 1 query returns an arbitrary row — in production this selected a
 * stale `pending` payment, executeDirectPayout rejected it, no payout was
 * ever issued at PayPal, and the milestone sat in `verifying` forever
 * waiting for a webhook that could never arrive
 * (PAYOUT_TRIGGER_FAILED_AFTER_APPROVAL).
 *
 * selectPayoutEligiblePayment is the single rule for "which payment do we
 * pay out": newest `processing` row, else newest `on_hold` row, else null
 * (caller reports an explicit skip instead of attempting a doomed payout).
 * Pure function — no database access; the caller passes all rows.
 */

export interface PayoutCandidateRow {
  id: string;
  status: string;
  updatedAt: Date | string | null;
  paypalPayoutBatchId?: string | null;
}

const ELIGIBLE_STATUSES = ["processing", "on_hold"] as const;

function rowTime(row: PayoutCandidateRow): number {
  if (row.updatedAt instanceof Date) return row.updatedAt.getTime();
  if (typeof row.updatedAt === "string") {
    const t = new Date(row.updatedAt).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

export function selectPayoutEligiblePayment<T extends PayoutCandidateRow>(
  rows: readonly T[]
): T | null {
  const eligible = rows.filter((r) =>
    (ELIGIBLE_STATUSES as readonly string[]).includes(r.status)
  );
  if (eligible.length === 0) return null;
  // Newest first; `processing` outranks `on_hold` (captured funds beat held).
  const rank = (status: string): number =>
    status === "processing" ? 0 : 1;
  return [...eligible].sort((a, b) => {
    const rankDiff = rank(a.status) - rank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return rowTime(b) - rowTime(a);
  })[0];
}

/** True when a payout was already issued for this payment (retry-safe). */
export function isPayoutIssued<T extends PayoutCandidateRow>(row: T): boolean {
  return (
    row.paypalPayoutBatchId !== null &&
    row.paypalPayoutBatchId !== undefined &&
    row.paypalPayoutBatchId !== ""
  );
}
