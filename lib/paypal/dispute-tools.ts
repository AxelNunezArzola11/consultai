/**
 * Custom PayPal Disputes REST API tools — Phase 6
 *
 * The PayPal Agent Toolkit exposes only:
 *   list_disputes, get_dispute, accept_dispute_claim
 *
 * These two additional actions are NOT in the toolkit and are custom tools
 * built directly over the PayPal Disputes REST API v1.
 *
 * IMPORTANT DESIGN RULES (from consultai-plan.md §6.5):
 *   - These tools are NEVER exposed to the DisputeAgent LLM.
 *   - They are called ONLY by server code after human approval.
 *   - The LLM proposes an action; a human approves; SERVER CODE executes.
 *   - No auto-accept, no auto-refund, no auto-offer.
 *
 * UNVERIFIED STATUS:
 *   Both endpoints are confirmed in PayPal docs but have NOT been called
 *   in the sandbox yet. All response shapes are UNVERIFIED until a sandbox
 *   call succeeds. Marked with [UNVERIFIED] comments throughout.
 *
 * Docs:
 *   provide-evidence: https://developer.paypal.com/docs/api/customer-disputes/v1/#disputes_provide-evidence
 *   make-offer:       https://developer.paypal.com/docs/api/customer-disputes/v1/#disputes_make-offer
 *   accept-claim:     https://developer.paypal.com/docs/api/customer-disputes/v1/#disputes_accept-claim
 */

import { z } from "zod";
import { tool } from "ai";
import { paypalFetch, safeJson } from "@/lib/paypal/client";
import { db } from "@/lib/db";
import { disputes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { assertEvidenceNotSubmitted } from "@/lib/state-machines/dispute";
import { writeAuditLog } from "@/lib/db/audit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DisputeEvidenceDocument {
  /** evidence_type — UNVERIFIED list; likely includes PROOF_OF_FULFILLMENT, PROOF_OF_DELIVERY, etc. */
  evidence_type: string;
  /** notes — free text note for this evidence item */
  notes?: string;
  /**
   * documents — array of { name, url } pairs.
   * UNVERIFIED: the PayPal provide-evidence endpoint may accept JSON with document URLs,
   * or may require multipart/form-data for binary uploads.
   * Phase 6 implementation: JSON with publicly accessible document URLs only.
   * Binary file upload (multipart) is a future enhancement.
   */
  documents?: Array<{ name: string; url: string }>;
}

export interface ProvideEvidenceResult {
  success: boolean;
  /** HTTP status from PayPal */
  httpStatus: number;
  /** Parsed response body — UNVERIFIED shape */
  body: Record<string, unknown>;
  /** If success=false, the error message */
  error?: string;
}

export interface MakeOfferResult {
  success: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  error?: string;
}

export interface AcceptClaimResult {
  success: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Core API functions (server code — NOT LLM tools)
// ---------------------------------------------------------------------------

/**
 * Submits evidence for a dispute to PayPal.
 *
 * IDEMPOTENCY GUARD: reads evidence_status from the disputes table.
 * If status is "submitted", throws DisputeEvidenceAlreadySubmittedError immediately.
 * On success, updates evidence_status to "submitted" and sets evidence_submitted_at.
 * On failure, updates evidence_status to "failed".
 *
 * Content-Type: application/json — UNVERIFIED.
 * The PayPal docs suggest multipart/form-data for binary file uploads.
 * This implementation sends JSON with document URLs (Phase 6 scope).
 *
 * HTTP 204 on success — UNVERIFIED. Some PayPal action endpoints return 200 or 204.
 *
 * @param disputeRowId — our DB disputes.id (for idempotency check + status update)
 * @param paypalDisputeId — PayPal dispute_id (e.g. PP-D-XXXX)
 * @param evidenceList — array of evidence documents
 * @param note — overall note for the evidence submission
 */
export async function provideDisputeEvidence(
  disputeRowId: string,
  paypalDisputeId: string,
  evidenceList: DisputeEvidenceDocument[],
  note: string
): Promise<ProvideEvidenceResult> {
  // ── 1. Idempotency guard ───────────────────────────────────────────────
  const rows = await db
    .select({ id: disputes.id, evidenceStatus: disputes.evidenceStatus })
    .from(disputes)
    .where(eq(disputes.id, disputeRowId))
    .limit(1);

  if (rows.length === 0) {
    return { success: false, httpStatus: 0, body: {}, error: `Dispute row not found: ${disputeRowId}` };
  }

  // Throws DisputeEvidenceAlreadySubmittedError if already submitted
  assertEvidenceNotSubmitted(rows[0].evidenceStatus as "not_submitted" | "submitted" | "failed");

  // ── 2. Call PayPal provide-evidence endpoint ───────────────────────────
  // UNVERIFIED: exact request body shape, content-type, and response status
  const requestBody = {
    // note goes at the top level — UNVERIFIED
    note,
    // evidence_info contains the typed evidence list — UNVERIFIED field name
    evidence_info: {
      // UNVERIFIED: whether the array field is named "evidence_info" or directly the evidence_type
      evidence_type: evidenceList.length === 1 ? evidenceList[0].evidence_type : "PROOF_OF_FULFILLMENT",
      notes: evidenceList.map((e) => e.notes ?? "").join("; "),
      documents: evidenceList.flatMap((e) => e.documents ?? []),
    },
  };

  let res: Response;
  try {
    res = await paypalFetch(
      `/v1/customer/disputes/${paypalDisputeId}/provide-evidence`,
      {
        method: "POST",
        body: JSON.stringify(requestBody),
      }
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Update evidence_status to failed
    await db
      .update(disputes)
      .set({ evidenceStatus: "failed", updatedAt: new Date() })
      .where(eq(disputes.id, disputeRowId));
    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeRowId,
      event: "DISPUTE_EVIDENCE_SUBMIT_ERROR",
      actor: "system",
      payload: { paypalDisputeId, error: errorMsg },
    });
    return { success: false, httpStatus: 0, body: {}, error: errorMsg };
  }

  const body = await safeJson(res);

  // ── 3. Handle response ─────────────────────────────────────────────────
  // PayPal action endpoints typically return 200 or 204 on success — UNVERIFIED
  const success = res.status === 200 || res.status === 204;

  if (success) {
    await db
      .update(disputes)
      .set({
        evidenceStatus: "submitted",
        evidenceSubmittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(disputes.id, disputeRowId));
    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeRowId,
      event: "DISPUTE_EVIDENCE_SUBMITTED",
      actor: "system",
      payload: { paypalDisputeId, httpStatus: res.status, note: note.slice(0, 200) },
    });
  } else {
    await db
      .update(disputes)
      .set({ evidenceStatus: "failed", updatedAt: new Date() })
      .where(eq(disputes.id, disputeRowId));
    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeRowId,
      event: "DISPUTE_EVIDENCE_SUBMIT_FAILED",
      actor: "system",
      payload: { paypalDisputeId, httpStatus: res.status, body },
    });
  }

  return {
    success,
    httpStatus: res.status,
    body,
    error: success ? undefined : `PayPal returned HTTP ${res.status}`,
  };
}

/**
 * Makes a settlement offer for a dispute.
 *
 * UNVERIFIED: request body shape, offer_type values, response shape.
 * This implementation follows the documented endpoint but has NOT been called in sandbox.
 *
 * offer_type values (UNVERIFIED): REFUND | PARTIAL_REFUND
 * HTTP 200 on success — UNVERIFIED.
 *
 * Note: this function is called by SERVER CODE only after human approval.
 * The LLM proposes the amount; the human approves via the DisputeView UI.
 */
export async function makeDisputeOffer(
  disputeRowId: string,
  paypalDisputeId: string,
  offerAmountUsd: string,
  offerType: "REFUND" | "PARTIAL_REFUND",
  note: string
): Promise<MakeOfferResult> {
  // Validate amount is a positive number string
  const amount = parseFloat(offerAmountUsd);
  if (isNaN(amount) || amount <= 0) {
    return { success: false, httpStatus: 0, body: {}, error: `Invalid offer amount: ${offerAmountUsd}` };
  }

  // UNVERIFIED: exact request body field names
  const requestBody = {
    offer_type: offerType,
    // UNVERIFIED: whether the amount is nested under offer_amount or at top level
    offer_amount: {
      currency_code: "USD",
      value: offerAmountUsd,
    },
    note,
  };

  let res: Response;
  try {
    res = await paypalFetch(
      `/v1/customer/disputes/${paypalDisputeId}/make-offer`,
      {
        method: "POST",
        body: JSON.stringify(requestBody),
      }
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeRowId,
      event: "DISPUTE_OFFER_ERROR",
      actor: "system",
      payload: { paypalDisputeId, error: errorMsg },
    });
    return { success: false, httpStatus: 0, body: {}, error: errorMsg };
  }

  const body = await safeJson(res);
  const success = res.status === 200 || res.status === 201;

  if (success) {
    await db
      .update(disputes)
      .set({
        offerAmountUsd,
        offerSubmittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(disputes.id, disputeRowId));
    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeRowId,
      event: "DISPUTE_OFFER_SUBMITTED",
      actor: "system",
      payload: { paypalDisputeId, offerAmountUsd, offerType, httpStatus: res.status },
    });
  } else {
    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeRowId,
      event: "DISPUTE_OFFER_FAILED",
      actor: "system",
      payload: { paypalDisputeId, httpStatus: res.status, body },
    });
  }

  return {
    success,
    httpStatus: res.status,
    body,
    error: success ? undefined : `PayPal returned HTTP ${res.status}`,
  };
}

/**
 * Accepts a dispute claim (the merchant concedes).
 * Uses the toolkit-confirmed endpoint: POST /v1/customer/disputes/{id}/accept-claim
 * This calls the same endpoint as the toolkit's accept_dispute_claim tool,
 * but from server code (after human approval).
 *
 * NOTE: This function is NEVER called automatically.
 * It requires explicit human approval in the DisputeView UI.
 */
export async function acceptDisputeClaim(
  disputeRowId: string,
  paypalDisputeId: string,
  note: string
): Promise<AcceptClaimResult> {
  let res: Response;
  try {
    res = await paypalFetch(
      `/v1/customer/disputes/${paypalDisputeId}/accept-claim`,
      {
        method: "POST",
        body: JSON.stringify({ note }),
      }
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await writeAuditLog({
      entityType: "dispute",
      entityId: disputeRowId,
      event: "DISPUTE_ACCEPT_CLAIM_ERROR",
      actor: "system",
      payload: { paypalDisputeId, error: errorMsg },
    });
    return { success: false, httpStatus: 0, body: {}, error: errorMsg };
  }

  const body = await safeJson(res);
  const success = res.status === 200 || res.status === 204;

  await writeAuditLog({
    entityType: "dispute",
    entityId: disputeRowId,
    event: success ? "DISPUTE_CLAIM_ACCEPTED" : "DISPUTE_ACCEPT_CLAIM_FAILED",
    actor: "system",
    payload: { paypalDisputeId, httpStatus: res.status, body: success ? {} : body },
  });

  return {
    success,
    httpStatus: res.status,
    body,
    error: success ? undefined : `PayPal returned HTTP ${res.status}`,
  };
}

// ---------------------------------------------------------------------------
// READ-ONLY Vercel AI SDK tools for the DisputeAgent LLM
//
// HARD RULE: provideDisputeEvidence, makeDisputeOffer, acceptDisputeClaim
// are NOT included here. They are server-code-only functions above.
// The DisputeAgent LLM receives only read tools.
// ---------------------------------------------------------------------------

/**
 * Read-only tool: get the dispute details from the disputes table.
 * Returns the stored dispute row for the LLM to reason about.
 * Does NOT call PayPal API directly (uses cached DB state).
 *
 * This is the only tool exposed to the DisputeAgent LLM for dispute data.
 */
export const getDisputeDetails = tool({
  description:
    "Get the current dispute details from the database, including status, reason, amount, " +
    "and evidence list. Use this to understand the dispute before drafting a response.",
  inputSchema: z.object({
    disputeRowId: z.string().describe("The internal disputes table row ID"),
  }),
  execute: async ({ disputeRowId }: { disputeRowId: string }) => {
    const rows = await db
      .select()
      .from(disputes)
      .where(eq(disputes.id, disputeRowId))
      .limit(1);

    if (rows.length === 0) {
      return { error: `Dispute not found: ${disputeRowId}` };
    }

    const d = rows[0];
    // Return safe fields only — no internal IDs that buyer messages could exploit
    return {
      status: d.status,
      paypalStatus: d.paypalStatus,
      disputeReason: d.disputeReason,
      disputeChannel: d.disputeChannel,
      disputeLifeCycleStage: d.disputeLifeCycleStage,
      disputeAmountUsd: d.disputeAmountUsd,
      disputeAmountCurrency: d.disputeAmountCurrency,
      evidenceStatus: d.evidenceStatus,
      evidenceSubmittedAt: d.evidenceSubmittedAt?.toISOString() ?? null,
      offerAmountUsd: d.offerAmountUsd,
      offerSubmittedAt: d.offerSubmittedAt?.toISOString() ?? null,
      resolutionOutcome: d.resolutionOutcome,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  },
});
