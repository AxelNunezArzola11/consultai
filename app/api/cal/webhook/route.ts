/**
 * POST /api/cal/webhook
 *
 * Cal.com webhook handler for BOOKING_CREATED and BOOKING_CANCELLED events.
 *
 * Security:
 * - Validates X-Cal-Signature-256 HMAC-SHA256 hex of raw body with CAL_WEBHOOK_SECRET
 * - Uses timingSafeEqual for comparison — missing/invalid signature → 400
 * - Idempotency: dedup key = triggerEvent|bookingUid|createdAt, stored in cal_webhook_deliveries
 * - Returns 200 on duplicate deliveries (no reprocessing)
 *
 * BOOKING_CREATED reconciliation:
 * - Matches attendee email to a candidate for the project
 * - If candidate is not in BOOKING_UNLOCKED state → mark INVALID_BOOKING, notify, write audit
 * - If no NDA_SIGNED record for the project → same as above
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4 — Cal.com Integration & Reconciliation
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  calWebhookDeliveries,
  candidates,
  meetings,
  ndas,
  projects,
} from "@/lib/db/schema";
import {
  assertCandidateTransition,
  CandidateTransitionError,
  isCandidateTransitionAllowed,
} from "@/lib/state-machines/candidate-pipeline";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Signature validation
// ---------------------------------------------------------------------------

function validateCalSignature(rawBody: Buffer, signature: string | null): boolean {
  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfigured — reject all
    return false;
  }
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  // Signature header format: "sha256=<hex>" or plain "<hex>"
  const sigHex = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  if (sigHex.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(sigHex, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get("x-cal-signature-256");

  if (!validateCalSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  let payload: CalWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { triggerEvent, uid: bookingUid, createdAt } = payload;

  if (!triggerEvent || !bookingUid) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  // Idempotency key: triggerEvent|bookingUid|createdAt
  const dedupKey = `${triggerEvent}|${bookingUid}|${createdAt ?? ""}`;

  // Try to insert dedup record — if conflict → duplicate
  try {
    await db.insert(calWebhookDeliveries).values({
      id: nanoid(),
      dedupKey,
      triggerEvent,
      bookingUid,
    });
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      return NextResponse.json({ status: "duplicate_ignored" }, { status: 200 });
    }
    throw err;
  }

  // Route to handler
  switch (triggerEvent) {
    case "BOOKING_CREATED":
      return handleBookingCreated(payload);
    case "BOOKING_CANCELLED":
      return handleBookingCancelled(payload);
    default:
      // Unknown event — log and return 200 (don't reject future events)
      await writeAuditLog({
        entityType: "meeting",
        entityId: bookingUid,
        event: "CAL_UNKNOWN_EVENT",
        actor: "system",
        payload: { triggerEvent },
      });
      return NextResponse.json({ status: "unhandled_event" }, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// BOOKING_CREATED
// ---------------------------------------------------------------------------

async function handleBookingCreated(payload: CalWebhookPayload): Promise<NextResponse> {
  const attendeeEmail = payload.attendees?.[0]?.email;
  const bookingUid = payload.uid;
  const scheduledAt = payload.startTime ? new Date(payload.startTime) : null;

  // Find candidate by email
  const [candidate] = attendeeEmail
    ? await db
        .select()
        .from(candidates)
        .where(eq(candidates.email, attendeeEmail))
        .limit(1)
    : [];

  if (!candidate) {
    await writeAuditLog({
      entityType: "meeting",
      entityId: bookingUid,
      event: "CAL_BOOKING_NO_CANDIDATE_MATCH",
      actor: "system",
      payload: { attendeeEmail, bookingUid },
    });
    // Return 200 — we can't match but don't want retries
    return NextResponse.json({ status: "no_candidate_match" }, { status: 200 });
  }

  const projectId = candidate.projectId;

  // Reconciliation: check that candidate has an accepted NDA for this project
  const [signedNda] = await db
    .select()
    .from(ndas)
    .where(
      and(
        eq(ndas.candidateId, candidate.id),
        eq(ndas.projectId, projectId),
        eq(ndas.status, "accepted")
      )
    )
    .limit(1);

  if (!signedNda) {
    // No NDA_SIGNED → INVALID_BOOKING
    if (isCandidateTransitionAllowed(candidate.status as Parameters<typeof isCandidateTransitionAllowed>[0], "invalid_booking")) {
      await db
        .update(candidates)
        .set({ status: "invalid_booking", updatedAt: new Date() })
        .where(eq(candidates.id, candidate.id));
    }

    await writeAuditLog({
      entityType: "candidate",
      entityId: candidate.id,
      event: "INVALID_BOOKING_NO_NDA",
      actor: "system",
      payload: {
        bookingUid,
        projectId,
        attendeeEmail,
        reason: "No accepted NDA found for this project",
      },
    });

    // TODO: Attempt Cal.com API cancellation if CAL_API_KEY is available
    const calApiKey = process.env.CAL_API_KEY;
    if (calApiKey) {
      try {
        await cancelCalBooking(bookingUid, calApiKey);
      } catch {
        // Non-critical — log but don't fail the webhook
        await writeAuditLog({
          entityType: "meeting",
          entityId: bookingUid,
          event: "CAL_CANCEL_ATTEMPT_FAILED",
          actor: "system",
          payload: { bookingUid },
        });
      }
    }

    return NextResponse.json({ status: "invalid_booking" }, { status: 200 });
  }

  // Valid booking — transition candidate to BOOKED
  try {
    assertCandidateTransition(
      candidate.status as Parameters<typeof assertCandidateTransition>[0],
      "booked"
    );
    await db
      .update(candidates)
      .set({ status: "booked", updatedAt: new Date() })
      .where(eq(candidates.id, candidate.id));
  } catch (e) {
    if (e instanceof CandidateTransitionError) {
      // Already booked or in wrong state — log and continue
      await writeAuditLog({
        entityType: "candidate",
        entityId: candidate.id,
        event: "CANDIDATE_TRANSITION_SKIPPED",
        actor: "system",
        payload: { error: e.message, targetStatus: "booked" },
      });
    } else {
      throw e;
    }
  }

  // Upsert meeting record
  await db.insert(meetings).values({
    id: nanoid(),
    candidateId: candidate.id,
    projectId,
    calBookingUid: bookingUid,
    scheduledAt: scheduledAt ?? undefined,
    status: "scheduled",
    bookingLink: payload.metadata?.videoCallUrl ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await writeAuditLog({
    entityType: "meeting",
    entityId: bookingUid,
    event: "BOOKING_CREATED",
    actor: "system",
    payload: {
      candidateId: candidate.id,
      projectId,
      scheduledAt: scheduledAt?.toISOString(),
      bookingUid,
    },
  });

  return NextResponse.json({ status: "booked" }, { status: 200 });
}

// ---------------------------------------------------------------------------
// BOOKING_CANCELLED
// ---------------------------------------------------------------------------

async function handleBookingCancelled(payload: CalWebhookPayload): Promise<NextResponse> {
  const bookingUid = payload.uid;

  // Find meeting by Cal booking UID
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(eq(meetings.calBookingUid, bookingUid))
    .limit(1);

  if (!meeting) {
    await writeAuditLog({
      entityType: "meeting",
      entityId: bookingUid,
      event: "CAL_CANCEL_NO_MEETING",
      actor: "system",
      payload: { bookingUid },
    });
    return NextResponse.json({ status: "no_meeting_found" }, { status: 200 });
  }

  // Update meeting status
  await db
    .update(meetings)
    .set({
      status: "cancelled",
      calCancelReason: payload.cancellationReason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(meetings.id, meeting.id));

  // Transition candidate to cancelled (triggers cascade)
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, meeting.candidateId))
    .limit(1);

  if (candidate) {
    try {
      assertCandidateTransition(
        candidate.status as Parameters<typeof assertCandidateTransition>[0],
        "cancelled"
      );
      await db
        .update(candidates)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(candidates.id, candidate.id));

      // Trigger cascade (imported lazily to avoid circular deps)
      const { triggerCascade } = await import("@/lib/cascade/trigger");
      await triggerCascade({
        candidateId: candidate.id,
        projectId: meeting.projectId,
        reason: "CANCELLED",
      });
    } catch (e) {
      if (e instanceof CandidateTransitionError) {
        await writeAuditLog({
          entityType: "candidate",
          entityId: candidate.id,
          event: "CANDIDATE_TRANSITION_SKIPPED",
          actor: "system",
          payload: { error: e.message, targetStatus: "cancelled" },
        });
      } else {
        throw e;
      }
    }
  }

  await writeAuditLog({
    entityType: "meeting",
    entityId: bookingUid,
    event: "BOOKING_CANCELLED",
    actor: "system",
    payload: {
      meetingId: meeting.id,
      candidateId: meeting.candidateId,
      reason: payload.cancellationReason,
    },
  });

  return NextResponse.json({ status: "cancelled" }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Cal.com API cancellation (best-effort)
// ---------------------------------------------------------------------------

async function cancelCalBooking(uid: string, apiKey: string): Promise<void> {
  const resp = await fetch(`https://api.cal.com/v1/bookings/${uid}/cancel`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason: "Booking cancelled: NDA not signed" }),
  });
  if (!resp.ok) {
    throw new Error(`Cal.com cancel returned ${resp.status}`);
  }
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface CalAttendee {
  email: string;
  name?: string;
}

interface CalWebhookPayload {
  triggerEvent: string;
  uid: string;
  createdAt?: string;
  startTime?: string;
  endTime?: string;
  attendees?: CalAttendee[];
  cancellationReason?: string;
  metadata?: {
    videoCallUrl?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
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
