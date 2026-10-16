/**
 * POST /api/demo/simulate-cancellation
 *
 * DEMO_MODE only — simulates a booking cancellation for a candidate.
 * Transitions the candidate to CANCELLED and triggers cascade.
 *
 * ⚠️ DEMO ONLY — this route is disabled when DEMO_MODE is not "true".
 * Must be labeled as demo-only in UI and README.
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4 — UI & Demo Controls
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { candidates, meetings } from "@/lib/db/schema";
import {
  assertCandidateTransition,
  CandidateTransitionError,
} from "@/lib/state-machines/candidate-pipeline";
import { triggerCascade } from "@/lib/cascade/trigger";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.DEMO_MODE !== "true" && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "demo_mode_disabled" }, { status: 403 });
  }

  let body: { candidateId?: string; projectId?: string };
  try {
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

  // Update any scheduled meeting to cancelled
  await db
    .update(meetings)
    .set({
      status: "cancelled",
      calCancelReason: "Demo cancellation",
      updatedAt: new Date(),
    })
    .where(eq(meetings.candidateId, candidateId));

  // Transition candidate to cancelled
  try {
    const from = candidate.status as Parameters<typeof assertCandidateTransition>[0];
    assertCandidateTransition(from, "cancelled");
    await db
      .update(candidates)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(candidates.id, candidateId));
  } catch (e) {
    if (!(e instanceof CandidateTransitionError)) throw e;
    // Force transition for demo
    await db
      .update(candidates)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(candidates.id, candidateId));
  }

  // Trigger cascade
  await triggerCascade({ candidateId, projectId, reason: "CANCELLED" });

  await writeAuditLog({
    entityType: "candidate",
    entityId: candidateId,
    event: "DEMO_CANCELLATION",
    actor: "demo",
    payload: { candidateId, projectId },
  });

  // Redirect back
  const referer = req.headers.get("referer");
  if (referer) {
    return NextResponse.redirect(referer, 303);
  }
  return NextResponse.json({ status: "cancelled", candidateId });
}
