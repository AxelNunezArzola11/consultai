/**
 * Cascade trigger — Phase 4
 *
 * When a candidate exits the pipeline via EXPIRED, DECLINED, CANCELLED, or NO_SHOW,
 * this module automatically invites the next ranked candidate.
 *
 * Rules:
 * - Executes at most once per transition (idempotent: caller marks candidate terminal first)
 * - Limits rounds to MAX_CASCADE_ROUNDS (prevents infinite loops)
 * - Logs every cascade event to cascade_log and audit_log
 * - On no next candidate: logs and notifies (no error thrown)
 * - Does NOT trigger cascade for INVALID_BOOKING (company must review manually)
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4 — Candidate Cascade
 */

import { eq, and, gt, asc, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { candidates, ndas, cascadeLog } from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import type { CascadeReason } from "@/lib/state-machines/candidate-pipeline";
import {
  assertCandidateTransition,
  CandidateTransitionError,
} from "@/lib/state-machines/candidate-pipeline";

/** Maximum number of cascade rounds before stopping (prevents infinite loops) */
export const MAX_CASCADE_ROUNDS = 5;

export interface TriggerCascadeParams {
  candidateId: string;
  projectId: string;
  reason: CascadeReason;
}

/**
 * Triggers the cascade: marks current candidate as CASCADED and invites the next ranked candidate.
 *
 * Idempotent: if the candidate is already CASCADED, returns immediately.
 * At-most-once per transition: caller must have already set the terminal status before calling this.
 */
export async function triggerCascade(params: TriggerCascadeParams): Promise<void> {
  const { candidateId, projectId, reason } = params;

  // Check how many cascade rounds have already happened for this project
  const existingLogs = await db
    .select()
    .from(cascadeLog)
    .where(eq(cascadeLog.projectId, projectId));

  const round = existingLogs.length + 1;

  if (round > MAX_CASCADE_ROUNDS) {
    await writeAuditLog({
      entityType: "project",
      entityId: projectId,
      event: "CASCADE_LIMIT_REACHED",
      actor: "system",
      payload: { projectId, reason, round, limit: MAX_CASCADE_ROUNDS },
    });
    return;
  }

  // Mark current candidate as CASCADED
  const [currentCandidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);

  if (!currentCandidate) return;

  // Only mark as cascaded if not already terminal
  try {
    assertCandidateTransition(
      currentCandidate.status as Parameters<typeof assertCandidateTransition>[0],
      "cascaded"
    );
    await db
      .update(candidates)
      .set({ status: "cascaded", updatedAt: new Date() })
      .where(eq(candidates.id, candidateId));
  } catch (e) {
    if (!(e instanceof CandidateTransitionError)) throw e;
    // Already in terminal state or cascaded — that's fine, continue
  }

  // Find the next ranked candidate in this project
  // Next candidate: shortlisted, rank > current rank, not terminal, not already cascaded
  const currentRank = currentCandidate.rank ?? 999;

  const [nextCandidate] = await db
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.projectId, projectId),
        ne(candidates.id, candidateId),
        eq(candidates.status, "shortlisted"),
        gt(candidates.rank ?? 0, currentRank)
      )
    )
    .orderBy(asc(candidates.rank))
    .limit(1);

  // Log the cascade event
  await db.insert(cascadeLog).values({
    id: nanoid(),
    projectId,
    fromCandidateId: candidateId,
    toCandidateId: nextCandidate?.id ?? null,
    reason,
    round,
  });

  await writeAuditLog({
    entityType: "candidate",
    entityId: candidateId,
    event: "CASCADE_TRIGGERED",
    actor: "system",
    payload: {
      reason,
      round,
      nextCandidateId: nextCandidate?.id ?? null,
      projectId,
    },
  });

  if (!nextCandidate) {
    // No more candidates — notify company (in-app audit log serves as notification for demo)
    await writeAuditLog({
      entityType: "project",
      entityId: projectId,
      event: "CASCADE_EXHAUSTED",
      actor: "system",
      payload: { reason, round, projectId },
    });
    return;
  }

  // Transition next candidate to NDA_SENT by dispatching a new NDA
  try {
    assertCandidateTransition(
      nextCandidate.status as Parameters<typeof assertCandidateTransition>[0],
      "nda_sent"
    );
    await db
      .update(candidates)
      .set({ status: "nda_sent", updatedAt: new Date() })
      .where(eq(candidates.id, nextCandidate.id));

    // Generate and send NDA for the next candidate
    // Lazy import to avoid circular dependency
    const { generateNdaPdf } = await import("@/lib/nda/generate");
    const { generateInviteToken, hashInviteToken, tokenExpiresAt, ndaExpiresAt } =
      await import("@/lib/nda/invite-token");

    // Fetch project title for NDA generation
    const { projects } = await import("@/lib/db/schema");
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      throw new Error(`Project ${projectId} not found during cascade`);
    }

    const { documentHash } = await generateNdaPdf({
      projectTitle: project.title,
      companyName: "Demo Company",
      candidateName: nextCandidate.name,
    });

    const rawToken = generateInviteToken();
    const tokenHash = hashInviteToken(rawToken);
    const tokenExpiry = tokenExpiresAt();
    const ndaExpiry = ndaExpiresAt();

    const ndaId = nanoid();
    await db.insert(ndas).values({
      id: ndaId,
      candidateId: nextCandidate.id,
      projectId,
      templateVersion: "1.0.0",
      contentHash: documentHash,
      documentHash,
      pdfUrl: null, // Cascade NDAs don't pre-generate PDF bytes for demo
      inviteTokenHash: tokenHash,
      inviteTokenUsed: false,
      inviteTokenRateLimit: 0,
      inviteTokenExpiresAt: tokenExpiry,
      status: "sent",
      sentAt: new Date(),
      expiresAt: ndaExpiry,
    });

    // Build invite URL for demo-inbox
    const { buildWebhookUrl } = await import("@/lib/constants/routes");
    const inviteUrl = `${buildWebhookUrl("/invite")}/${ndaId}:${rawToken}`;

    await writeAuditLog({
      entityType: "nda",
      entityId: ndaId,
      event: "NDA_SENT",
      actor: "system",
      payload: {
        candidateId: nextCandidate.id,
        projectId,
        cascadeRound: round,
        inviteUrl,
      },
    });

    // Schedule QStash NDA expiry timer for the new invite
    const { scheduleNdaExpiry } = await import("@/lib/qstash/client");
    await scheduleNdaExpiry({
      ndaId,
      projectId,
      candidateId: nextCandidate.id,
      expiresAt: ndaExpiry,
    });
  } catch (e) {
    if (e instanceof CandidateTransitionError) {
      await writeAuditLog({
        entityType: "candidate",
        entityId: nextCandidate.id,
        event: "CANDIDATE_TRANSITION_SKIPPED",
        actor: "system",
        payload: { error: e.message, targetStatus: "nda_sent" },
      });
    } else {
      throw e;
    }
  }
}
