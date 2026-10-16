/**
 * POST /api/qstash/receive
 *
 * QStash message receiver. Handles NDA_EXPIRY and NO_SHOW_CHECK messages.
 *
 * Security:
 * - Verifies HMAC-SHA256 signature using current/next signing keys
 * - Uses timingSafeEqual for comparison
 * - Idempotency: records processed Upstash-Message-Id in qstash_deliveries
 * - Lazy expiry check: skips processing if the candidate is already in a terminal state
 *
 * Path is /api/qstash/receive (NOT /receiver — see Spike 8 notes in consultai-plan.md)
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4 — Timers (QStash)
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { qstashDeliveries, ndas, meetings, candidates } from "@/lib/db/schema";
import {
  assertCandidateTransition,
  CandidateTransitionError,
  isTerminal,
} from "@/lib/state-machines/candidate-pipeline";
import { writeAuditLog } from "@/lib/db/audit";
import type { QStashPayload } from "@/lib/qstash/client";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies the QStash HMAC-SHA256 signature.
 * Tries both the current and next signing keys (key rotation support).
 *
 * Header: "Upstash-Signature": "v1:<base64url-HMAC-SHA256>"
 * Content to sign: the raw body string
 */
function verifyQStashSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;

  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentKey && !nextKey) return false;

  // Header format: "v1:<base64url>"
  const prefix = "v1:";
  if (!signatureHeader.startsWith(prefix)) return false;
  const sigBase64 = signatureHeader.slice(prefix.length);

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sigBase64, "base64url");
  } catch {
    return false;
  }

  for (const key of [currentKey, nextKey]) {
    if (!key) continue;
    const expected = createHmac("sha256", key).update(rawBody).digest();
    if (expected.length === sigBytes.length) {
      try {
        if (timingSafeEqual(expected, sigBytes)) return true;
      } catch {
        // length mismatch handled above
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("upstash-signature");
  const messageId = req.headers.get("upstash-message-id") ?? "";

  if (!verifyQStashSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // Idempotency check — insert first; if conflict → duplicate
  if (messageId) {
    let payload: QStashPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    try {
      await db.insert(qstashDeliveries).values({
        messageId,
        payloadType: payload.type ?? "UNKNOWN",
        entityId: payload.entityId ?? "",
      });
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        return NextResponse.json({ status: "duplicate_ignored" }, { status: 200 });
      }
      throw err;
    }

    return routePayload(payload);
  }

  // No message ID — process but cannot guarantee idempotency
  let payload: QStashPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  return routePayload(payload);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function routePayload(payload: QStashPayload): Promise<NextResponse> {
  switch (payload.type) {
    case "NDA_EXPIRY":
      return handleNdaExpiry(payload);
    case "NO_SHOW_CHECK":
      return handleNoShowCheck(payload);
    default:
      await writeAuditLog({
        entityType: "candidate",
        entityId: payload.entityId ?? "unknown",
        event: "QSTASH_UNKNOWN_TYPE",
        actor: "system",
        payload: { type: (payload as { type: string }).type },
      });
      return NextResponse.json({ status: "unhandled_type" }, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// NDA_EXPIRY handler
// ---------------------------------------------------------------------------

async function handleNdaExpiry(payload: QStashPayload): Promise<NextResponse> {
  const { entityId: ndaId, candidateId, projectId } = payload;

  // Lazy check: if NDA is already accepted → no-op
  const [nda] = await db
    .select()
    .from(ndas)
    .where(eq(ndas.id, ndaId))
    .limit(1);

  if (!nda || nda.status === "accepted") {
    return NextResponse.json({ status: "noop_already_accepted" }, { status: 200 });
  }

  // Lazy check: if candidate is already in terminal state → no-op
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);

  if (candidate && isTerminal(candidate.status as Parameters<typeof isTerminal>[0])) {
    return NextResponse.json({ status: "noop_terminal" }, { status: 200 });
  }

  // Mark NDA as expired
  await db
    .update(ndas)
    .set({ status: "expired" })
    .where(eq(ndas.id, ndaId));

  // Transition candidate to expired
  if (candidate) {
    try {
      assertCandidateTransition(
        candidate.status as Parameters<typeof assertCandidateTransition>[0],
        "expired"
      );
      await db
        .update(candidates)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(candidates.id, candidateId));

      // Trigger cascade
      const { triggerCascade } = await import("@/lib/cascade/trigger");
      await triggerCascade({ candidateId, projectId, reason: "EXPIRED" });
    } catch (e) {
      if (e instanceof CandidateTransitionError) {
        await writeAuditLog({
          entityType: "candidate",
          entityId: candidateId,
          event: "CANDIDATE_TRANSITION_SKIPPED",
          actor: "system",
          payload: { error: e.message, targetStatus: "expired" },
        });
      } else {
        throw e;
      }
    }
  }

  await writeAuditLog({
    entityType: "nda",
    entityId: ndaId,
    event: "NDA_EXPIRED",
    actor: "system",
    payload: { candidateId, projectId },
  });

  return NextResponse.json({ status: "expired" }, { status: 200 });
}

// ---------------------------------------------------------------------------
// NO_SHOW_CHECK handler
// ---------------------------------------------------------------------------

async function handleNoShowCheck(payload: QStashPayload): Promise<NextResponse> {
  const { entityId: meetingId, candidateId, projectId } = payload;

  // Lazy check: if meeting is already in a resolved state → no-op
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  if (!meeting) {
    return NextResponse.json({ status: "noop_no_meeting" }, { status: 200 });
  }

  if (meeting.status === "held" || meeting.status === "cancelled") {
    return NextResponse.json({ status: "noop_resolved" }, { status: 200 });
  }

  // Lazy check: candidate already terminal → no-op
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);

  if (candidate && isTerminal(candidate.status as Parameters<typeof isTerminal>[0])) {
    return NextResponse.json({ status: "noop_terminal" }, { status: 200 });
  }

  // Mark meeting as no_show
  await db
    .update(meetings)
    .set({ status: "no_show", updatedAt: new Date() })
    .where(eq(meetings.id, meetingId));

  // Transition candidate to no_show
  if (candidate) {
    try {
      assertCandidateTransition(
        candidate.status as Parameters<typeof assertCandidateTransition>[0],
        "no_show"
      );
      await db
        .update(candidates)
        .set({ status: "no_show", updatedAt: new Date() })
        .where(eq(candidates.id, candidateId));

      // Trigger cascade
      const { triggerCascade } = await import("@/lib/cascade/trigger");
      await triggerCascade({ candidateId, projectId, reason: "NO_SHOW" });
    } catch (e) {
      if (e instanceof CandidateTransitionError) {
        await writeAuditLog({
          entityType: "candidate",
          entityId: candidateId,
          event: "CANDIDATE_TRANSITION_SKIPPED",
          actor: "system",
          payload: { error: e.message, targetStatus: "no_show" },
        });
      } else {
        throw e;
      }
    }
  }

  await writeAuditLog({
    entityType: "meeting",
    entityId: meetingId,
    event: "NO_SHOW_DETECTED",
    actor: "system",
    payload: { candidateId, projectId },
  });

  return NextResponse.json({ status: "no_show" }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.message.includes("duplicate key") ||
      err.message.includes("unique constraint") ||
      err.message.includes("UNIQUE constraint")
    );
  }
  return false;
}
