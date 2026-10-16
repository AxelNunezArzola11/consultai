/**
 * Invite token module — Phase 4
 *
 * Generates cryptographically random 128-bit invite tokens for NDA dispatch.
 *
 * Security properties:
 * - Token is 128-bit random (16 bytes from crypto.randomBytes), hex-encoded = 32 chars
 * - ONLY the SHA-256 hash of the token is stored in the DB (inviteTokenHash column)
 * - The raw token travels only in the invite link URL — never stored
 * - Single-use: inviteTokenUsed flag prevents replay
 * - Rate-limited: inviteTokenRateLimit prevents enumeration (max MAX_ATTEMPTS tries)
 * - Expiry: inviteTokenExpiresAt independent window (default 72h, demo 2min via env)
 * - No enumeration: all error paths return the same 404 response
 *
 * Source: consultai-plan.md §4 Phase 4 — Confidentiality Gate & NDA
 */

import { randomBytes, createHash, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of attempts before the token is permanently locked */
export const MAX_TOKEN_ATTEMPTS = 10;

/** Default token expiry window in hours */
const DEFAULT_EXPIRY_HOURS = 72;

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random 128-bit invite token (hex string, 32 chars).
 * Call this once per NDA invite. Do NOT store this value — store only the hash.
 */
export function generateInviteToken(): string {
  return randomBytes(16).toString("hex"); // 128-bit → 32 hex chars
}

/**
 * Computes the SHA-256 hex digest of a token string.
 * This is what gets stored in the DB (inviteTokenHash column).
 */
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Computes the SHA-256 hex digest of an arbitrary string.
 * Used for NDA document content hash and token hashing.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Timing-safe comparison of two hex digest strings.
 * Returns false (not throws) if lengths differ — prevents timing leak on length.
 */
export function timingSafeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ---------------------------------------------------------------------------
// Expiry helpers
// ---------------------------------------------------------------------------

/**
 * Returns the token expiry Date.
 *
 * In demo mode (NDA_EXPIRY_DEMO_MINUTES set), uses that many minutes.
 * Otherwise uses DEFAULT_EXPIRY_HOURS (72h).
 */
export function tokenExpiresAt(): Date {
  const demoMinutes = process.env.NDA_EXPIRY_DEMO_MINUTES
    ? parseInt(process.env.NDA_EXPIRY_DEMO_MINUTES, 10)
    : null;
  const now = Date.now();
  if (demoMinutes && Number.isFinite(demoMinutes)) {
    return new Date(now + demoMinutes * 60 * 1000);
  }
  return new Date(now + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000);
}

/**
 * Returns the NDA acceptance window expiry Date.
 * Identical to tokenExpiresAt() — they share the same env var for simplicity.
 */
export function ndaExpiresAt(): Date {
  return tokenExpiresAt();
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type TokenValidationResult =
  | { valid: true }
  | { valid: false; reason: "not_found" | "used" | "expired" | "rate_limited" };

/**
 * Validates a raw token against the stored NDA record fields.
 *
 * @param rawToken       - Token from the URL
 * @param storedHash     - inviteTokenHash from DB
 * @param used           - inviteTokenUsed from DB
 * @param expiresAt      - inviteTokenExpiresAt from DB (null = no expiry on token link)
 * @param attemptCount   - inviteTokenRateLimit from DB
 */
export function validateInviteToken(
  rawToken: string,
  storedHash: string | null,
  used: boolean,
  expiresAt: Date | null,
  attemptCount: number
): TokenValidationResult {
  // Rate limit check first — prevents enumeration even before hash comparison
  if (attemptCount >= MAX_TOKEN_ATTEMPTS) {
    return { valid: false, reason: "rate_limited" };
  }

  // No hash stored → this NDA was created before Phase 4 (legacy flow)
  if (!storedHash) {
    return { valid: false, reason: "not_found" };
  }

  // Expiry check
  if (expiresAt && new Date() > expiresAt) {
    return { valid: false, reason: "expired" };
  }

  // Single-use check
  if (used) {
    return { valid: false, reason: "used" };
  }

  // Timing-safe hash comparison
  const candidateHash = hashInviteToken(rawToken);
  if (!timingSafeCompareHex(candidateHash, storedHash)) {
    return { valid: false, reason: "not_found" }; // same response as missing — no enumeration
  }

  return { valid: true };
}
