/**
 * QStash client — Phase 4
 *
 * Publishes delayed messages for:
 * - NDA_EXPIRY: fires when an NDA invite window closes without acceptance
 * - NO_SHOW_CHECK: fires after a scheduled meeting time passes without check-in
 *
 * Rules (Spike 8 / Assumption 18):
 * - Receiver URL built from APP_BASE_URL + /api/qstash/receive (not /receiver)
 * - Never use window.location, VERCEL_URL, or VERCEL_BRANCH_URL
 * - Deterministic message ID = type:entityId for dedup
 *
 * Source: consultai-plan.md §4 Phase 4 — Timers (QStash) & Candidate Cascade
 * Spike 8 verified: 60 s delay works; free tier max delay = 7 days
 */

import { buildWebhookUrl } from "@/lib/constants/routes";

export type QStashPayloadType = "NDA_EXPIRY" | "NO_SHOW_CHECK";

export interface QStashPayload {
  type: QStashPayloadType;
  /** The entity this message acts on (ndaId for NDA_EXPIRY, meetingId for NO_SHOW_CHECK) */
  entityId: string;
  /** ISO timestamp of when the event was originally scheduled (for stale-check) */
  scheduledAt: string;
  /** Project ID for cascade context */
  projectId: string;
  /** Candidate ID for cascade context */
  candidateId: string;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const QSTASH_BASE = "https://qstash.upstash.io/v2/publish";

export interface PublishResult {
  messageId: string;
}

/**
 * Publishes a delayed message to QStash.
 *
 * @param payload - Message payload
 * @param delaySeconds - Delay in seconds before delivery
 * @param messageId - Deterministic message ID for idempotency (e.g. "NDA_EXPIRY:ndaId")
 */
export async function publishQStashMessage(
  payload: QStashPayload,
  delaySeconds: number,
  messageId?: string
): Promise<PublishResult> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error("QSTASH_TOKEN is not set");
  }

  const receiverUrl = buildWebhookUrl("/api/qstash/receive");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Upstash-Delay": `${delaySeconds}s`,
    "Upstash-Retries": "2",
  };

  // Deterministic message ID prevents duplicate schedules
  if (messageId) {
    headers["Upstash-Message-Id"] = messageId;
  }

  const resp = await fetch(`${QSTASH_BASE}/${encodeURIComponent(receiverUrl)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`QStash publish failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return { messageId: data.messageId ?? messageId ?? "" };
}

/**
 * Schedules an NDA expiry timer.
 * Message ID = "NDA_EXPIRY:{ndaId}" — idempotent if called twice.
 */
export async function scheduleNdaExpiry(params: {
  ndaId: string;
  projectId: string;
  candidateId: string;
  expiresAt: Date;
}): Promise<PublishResult> {
  const { ndaId, projectId, candidateId, expiresAt } = params;
  const now = Date.now();
  const delaySeconds = Math.max(
    0,
    Math.floor((expiresAt.getTime() - now) / 1000)
  );

  return publishQStashMessage(
    {
      type: "NDA_EXPIRY",
      entityId: ndaId,
      scheduledAt: new Date().toISOString(),
      projectId,
      candidateId,
    },
    delaySeconds,
    `NDA_EXPIRY:${ndaId}`
  );
}

/**
 * Schedules a no-show check timer.
 * Message ID = "NO_SHOW_CHECK:{meetingId}" — idempotent if called twice.
 * Fires 30 minutes after the scheduled meeting time (configurable).
 */
export async function scheduleNoShowCheck(params: {
  meetingId: string;
  projectId: string;
  candidateId: string;
  scheduledAt: Date;
}): Promise<PublishResult> {
  const { meetingId, projectId, candidateId, scheduledAt } = params;
  const NO_SHOW_GRACE_MINUTES = 30;
  const fireAt = new Date(scheduledAt.getTime() + NO_SHOW_GRACE_MINUTES * 60 * 1000);
  const now = Date.now();
  const delaySeconds = Math.max(0, Math.floor((fireAt.getTime() - now) / 1000));

  return publishQStashMessage(
    {
      type: "NO_SHOW_CHECK",
      entityId: meetingId,
      scheduledAt: scheduledAt.toISOString(),
      projectId,
      candidateId,
    },
    delaySeconds,
    `NO_SHOW_CHECK:${meetingId}`
  );
}
