/**
 * POST /api/demo/simulate-nda-signed
 *
 * DEMO_MODE only — simulates NDA acceptance for a candidate.
 * Transitions the candidate to NDA_SIGNED → BOOKING_UNLOCKED.
 *
 * ⚠️ DEMO ONLY — this route is disabled when DEMO_MODE is not "true".
 * Must be labeled as demo-only in UI and README.
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4 — UI & Demo Controls
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { candidates, ndas } from "@/lib/db/schema";
import {
  assertCandidateTransition,
  CandidateTransitionError,
} from "@/lib/state-machines/candidate-pipeline";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.DEMO_MODE !== "true" && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "demo_mode_disabled" }, { status: 403 });
  }

  let body: { candidateId?: string; projectId?: string };
  try {
    // Support both JSON body and form data
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      body = await req.json();
    } else {
      const formData = await req.formData();
      body = {
        candidateId: formData.get("candidateId")?.toString(),
        projectId: formData.get("projectId")?.toString(),
      };
    }
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { candidateId, projectId } = body;
  if (!candidateId || !projectId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const [candidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);

  if (!candidate) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Simulate: mark any sent NDA as accepted
  await db
    .update(ndas)
    .set({
      status: "accepted",
      acceptedAt: new Date(),
      acceptedName: `${candidate.name} (DEMO)`,
      acceptedIp: "127.0.0.1",
      inviteTokenUsed: true,
    })
    .where(
      and(
        eq(ndas.candidateId, candidateId),
        eq(ndas.status, "sent")
      )
    );

  // Transition candidate state
  try {
    const from = candidate.status as Parameters<typeof assertCandidateTransition>[0];
    assertCandidateTransition(from, "nda_signed");
    await db
      .update(candidates)
      .set({ status: "nda_signed", updatedAt: new Date() })
      .where(eq(candidates.id, candidateId));

    assertCandidateTransition("nda_signed", "booking_unlocked");
    await db
      .update(candidates)
      .set({ status: "booking_unlocked", updatedAt: new Date() })
      .where(eq(candidates.id, candidateId));
  } catch (e) {
    if (!(e instanceof CandidateTransitionError)) throw e;
    // Try a direct jump if the from state is unusual (e.g. pending → booking_unlocked)
    await db
      .update(candidates)
      .set({ status: "booking_unlocked", updatedAt: new Date() })
      .where(eq(candidates.id, candidateId));
  }

  await writeAuditLog({
    entityType: "candidate",
    entityId: candidateId,
    event: "DEMO_NDA_SIGNED",
    actor: "demo",
    payload: { candidateId, projectId },
  });

  // Redirect back to candidates page
  const referer = req.headers.get("referer");
  if (referer) {
    return NextResponse.redirect(referer, 303);
  }
  return NextResponse.json({ status: "nda_signed", candidateId });
}
