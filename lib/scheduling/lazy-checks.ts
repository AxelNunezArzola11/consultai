/**
 * Lazy expiry checker — Phase 4
 *
 * Called on every dashboard load and incoming webhook event to catch expired
 * NDAs and no-show candidates without relying solely on QStash delivery.
 *
 * This is the fallback mechanism (Assumption 9 in consultai-plan.md):
 * - QStash is the primary timer
 * - Lazy checks are the belt-and-suspenders safety net
 *
 * Rules:
 * - At most processes one expired NDA per call (to keep latency low)
 * - Non-blocking: errors are swallowed and logged (never crash the dashboard load)
 * - Idempotent: marks NDA as expired and calls triggerCascade (which is itself idempotent)
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4 — Timers (QStash) & Candidate Cascade
 */

import { and, eq, lt, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { ndas, candidates, meetings } from "@/lib/db/schema";
import {
  isCandidateTransitionAllowed,
  isTerminal,
} from "@/lib/state-machines/candidate-pipeline";
import { writeAuditLog } from "@/lib/db/audit";
import { triggerCascade } from "@/lib/cascade/trigger";

// ---------------------------------------------------------------------------
// Lazy NDA expiry sweep
// ---------------------------------------------------------------------------

/**
 * Sweeps for expired-but-not-yet-processed NDAs for a project.
 * Processes at most `limit` NDAs per call.
 */
export async function lazyExpireNdas(
  projectId: string,
  limit = 1
): Promise<{ processed: number }> {
  const now = new Date();

  const expiredNdas = await db
    .select()
    .from(ndas)
    .where(
      and(
        eq(ndas.projectId, projectId),
        eq(ndas.status, "sent"), // sent but not accepted
        isNotNull(ndas.expiresAt),
        lt(ndas.expiresAt!, now)
      )
    )
    .limit(limit);

  let processed = 0;

  for (const nda of expiredNdas) {
    try {
      // Mark NDA as expired
      await db
        .update(ndas)
        .set({ status: "expired" })
        .where(eq(ndas.id, nda.id));

      // Check candidate state before transitioning
      const [candidate] = await db
        .select()
        .from(candidates)
        .where(eq(candidates.id, nda.candidateId))
        .limit(1);

      if (
        candidate &&
        !isTerminal(candidate.status as Parameters<typeof isTerminal>[0]) &&
        isCandidateTransitionAllowed(
          candidate.status as Parameters<typeof isCandidateTransitionAllowed>[0],
          "expired"
        )
      ) {
        await db
          .update(candidates)
          .set({ status: "expired", updatedAt: new Date() })
          .where(eq(candidates.id, nda.candidateId));

        await triggerCascade({
          candidateId: nda.candidateId,
          projectId,
          reason: "EXPIRED",
        });
      }

      await writeAuditLog({
        entityType: "nda",
        entityId: nda.id,
        event: "NDA_EXPIRED_LAZY",
        actor: "system",
        payload: { candidateId: nda.candidateId, projectId },
      });

      processed++;
    } catch (err) {
      // Swallow — don't crash dashboard load
      console.error("[lazyExpireNdas] error:", err);
    }
  }

  return { processed };
}

// ---------------------------------------------------------------------------
// Lazy no-show sweep
// ---------------------------------------------------------------------------

/**
 * Sweeps for scheduled meetings that are past their scheduled time
 * and have not been marked held or cancelled.
 * Processes at most `limit` meetings per call.
 */
export async function lazyCheckNoShows(
  projectId: string,
  limit = 1
): Promise<{ processed: number }> {
  const NO_SHOW_GRACE_MS = 30 * 60 * 1000; // 30 minutes
  const cutoff = new Date(Date.now() - NO_SHOW_GRACE_MS);

  const staleMeetings = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.projectId, projectId),
        eq(meetings.status, "scheduled"),
        isNotNull(meetings.scheduledAt),
        lt(meetings.scheduledAt!, cutoff)
      )
    )
    .limit(limit);

  let processed = 0;

  for (const meeting of staleMeetings) {
    try {
      const [candidate] = await db
        .select()
        .from(candidates)
        .where(eq(candidates.id, meeting.candidateId))
        .limit(1);

      if (
        candidate &&
        !isTerminal(candidate.status as Parameters<typeof isTerminal>[0]) &&
        isCandidateTransitionAllowed(
          candidate.status as Parameters<typeof isCandidateTransitionAllowed>[0],
          "no_show"
        )
      ) {
        await db
          .update(meetings)
          .set({ status: "no_show", updatedAt: new Date() })
          .where(eq(meetings.id, meeting.id));

        await db
          .update(candidates)
          .set({ status: "no_show", updatedAt: new Date() })
          .where(eq(candidates.id, meeting.candidateId));

        await triggerCascade({
          candidateId: meeting.candidateId,
          projectId,
          reason: "NO_SHOW",
        });

        await writeAuditLog({
          entityType: "meeting",
          entityId: meeting.id,
          event: "NO_SHOW_DETECTED_LAZY",
          actor: "system",
          payload: { candidateId: meeting.candidateId, projectId },
        });
      }

      processed++;
    } catch (err) {
      console.error("[lazyCheckNoShows] error:", err);
    }
  }

  return { processed };
}
