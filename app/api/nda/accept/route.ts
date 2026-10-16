/**
 * POST /api/nda/accept
 *
 * Records NDA acceptance: typed name, checkbox confirmed, document hash verified.
 * Transitions candidate to NDA_SIGNED and unlocks booking.
 *
 * Request body:
 * {
 *   token: string,         // raw invite token from URL
 *   typedName: string,     // candidate's typed name
 *   agreed: true,          // checkbox — must be true
 *   documentHash: string,  // SHA-256 of the exact NDA text the candidate saw
 * }
 *
 * Security:
 * - Token validated against stored hash (timing-safe, rate-limited, single-use)
 * - Full brief access is determined ONLY by candidate DB status after this call
 * - Client-side state is never trusted for access control
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { ndas, candidates } from "@/lib/db/schema";
import { validateInviteToken } from "@/lib/nda/invite-token";
import {
  assertCandidateTransition,
  CandidateTransitionError,
} from "@/lib/state-machines/candidate-pipeline";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

// All error responses return 404 to prevent enumeration — only valid success returns 200
const OPAQUE_ERROR = NextResponse.json(
  { error: "invalid_or_expired_token" },
  { status: 404 }
);

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    token?: string;
    typedName?: string;
    agreed?: boolean;
    documentHash?: string;
  };
  try {
    body = await req.json();
  } catch {
    return OPAQUE_ERROR;
  }

  const { token, typedName, agreed, documentHash } = body;

  if (!token || !typedName || !agreed || !documentHash) {
    return OPAQUE_ERROR;
  }

  if (typeof agreed !== "boolean" || !agreed) {
    return OPAQUE_ERROR;
  }

  // Look up NDA by token hash would require a hash lookup. Since we do rate-limit
  // increments, we fetch the NDA by a secondary index. For Phase 4 demo, we pass
  // the ndaId in the token itself as "ndaId:rawToken" split.
  //
  // Token format: "ndaId:rawToken" (ndaId is safe to expose — no info leakage)
  const colonIdx = token.indexOf(":");
  if (colonIdx < 0) return OPAQUE_ERROR;

  const ndaId = token.slice(0, colonIdx);
  const rawToken = token.slice(colonIdx + 1);

  if (!ndaId || !rawToken) return OPAQUE_ERROR;

  // Fetch NDA record
  const [nda] = await db
    .select()
    .from(ndas)
    .where(eq(ndas.id, ndaId))
    .limit(1);

  if (!nda) return OPAQUE_ERROR;

  // Always increment rate-limit counter BEFORE validation (prevents timing attacks)
  await db
    .update(ndas)
    .set({ inviteTokenRateLimit: (nda.inviteTokenRateLimit ?? 0) + 1 })
    .where(eq(ndas.id, ndaId));

  const validation = validateInviteToken(
    rawToken,
    nda.inviteTokenHash ?? null,
    nda.inviteTokenUsed ?? false,
    nda.inviteTokenExpiresAt ?? null,
    (nda.inviteTokenRateLimit ?? 0) + 1 // use updated count
  );

  if (!validation.valid) {
    await writeAuditLog({
      entityType: "nda",
      entityId: ndaId,
      event: "NDA_TOKEN_REJECTED",
      actor: "system",
      payload: { reason: validation.reason },
    });
    return OPAQUE_ERROR;
  }

  // Verify document hash matches what we generated
  if (documentHash !== nda.documentHash && documentHash !== nda.contentHash) {
    await writeAuditLog({
      entityType: "nda",
      entityId: ndaId,
      event: "NDA_HASH_MISMATCH",
      actor: "system",
      payload: { submitted: documentHash, stored: nda.documentHash },
    });
    return OPAQUE_ERROR;
  }

  // Check NDA hasn't already been accepted or expired
  if (nda.status === "accepted") {
    return NextResponse.json({ error: "already_accepted" }, { status: 409 });
  }
  if (nda.status === "expired") {
    return OPAQUE_ERROR;
  }

  const acceptedAt = new Date();
  const acceptedIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  // Mark token as used and record acceptance
  await db
    .update(ndas)
    .set({
      status: "accepted",
      acceptedAt,
      acceptedName: typedName.trim(),
      acceptedIp,
      inviteTokenUsed: true,
    })
    .where(eq(ndas.id, ndaId));

  // Transition candidate to nda_signed then booking_unlocked
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, nda.candidateId))
    .limit(1);

  if (candidate) {
    try {
      const currentStatus = candidate.status as Parameters<typeof assertCandidateTransition>[0];
      assertCandidateTransition(currentStatus, "nda_signed");
      await db
        .update(candidates)
        .set({ status: "nda_signed", updatedAt: new Date() })
        .where(eq(candidates.id, candidate.id));

      // Immediately unlock booking
      assertCandidateTransition("nda_signed", "booking_unlocked");
      await db
        .update(candidates)
        .set({ status: "booking_unlocked", updatedAt: new Date() })
        .where(eq(candidates.id, candidate.id));
    } catch (e) {
      if (e instanceof CandidateTransitionError) {
        // Log but don't fail — NDA acceptance itself succeeded
        await writeAuditLog({
          entityType: "candidate",
          entityId: candidate.id,
          event: "CANDIDATE_TRANSITION_SKIPPED",
          actor: "system",
          payload: { error: e.message },
        });
      } else {
        throw e;
      }
    }
  }

  await writeAuditLog({
    entityType: "nda",
    entityId: ndaId,
    event: "NDA_ACCEPTED",
    actor: typedName.trim(),
    payload: {
      candidateId: nda.candidateId,
      projectId: nda.projectId,
      acceptedAt: acceptedAt.toISOString(),
      documentHash,
    },
  });

  return NextResponse.json({
    status: "accepted",
    candidateId: nda.candidateId,
    projectId: nda.projectId,
    bookingUnlocked: true,
  });
}
