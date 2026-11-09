/**
 * lib/brief/creator-scope.ts — creator binding for brief drafts + brief quota.
 *
 * The planner UI supplies `agentSessionId` from the client, so it cannot
 * identify the caller: two users in the same company can (accidentally or
 * deliberately) reuse the same id. Namespacing the stored key with the
 * authenticated creator's userId makes every (creator, session, project)
 * draft independent — a caller replaying another user's id writes a
 * different row instead of overwriting it.
 *
 * No schema change is needed: the stored key fits the existing
 * `agent_session_id` text columns (brief_drafts, brief_rate_limit), and no
 * reader looks drafts up by the raw client id (brief_draft selects only the
 * row id for the upsert check; project delete cascades by projectId).
 *
 * Separator ":" never appears in userIds (`user-<uuid>` / `user-demo-*`) or
 * in validated agentSessionIds ([a-zA-Z0-9_-]+), so keys stay unambiguous.
 */

export function creatorScopedKey(userId: string, agentSessionId: string): string {
  return `${userId}:${agentSessionId}`;
}
