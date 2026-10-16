/**
 * Invite token module tests — Phase 4
 */

import { describe, it, expect } from "vitest";
import {
  generateInviteToken,
  hashInviteToken,
  sha256Hex,
  timingSafeCompareHex,
  validateInviteToken,
  MAX_TOKEN_ATTEMPTS,
  type TokenValidationResult,
} from "@/lib/nda/invite-token";

describe("generateInviteToken", () => {
  it("generates a 32-character hex string (128-bit)", () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, generateInviteToken));
    expect(tokens.size).toBe(100);
  });
});

describe("hashInviteToken", () => {
  it("returns a 64-character hex SHA-256", () => {
    const hash = hashInviteToken("abc123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const token = "deadbeef0123456789abcdef";
    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
  });

  it("is different for different inputs", () => {
    expect(hashInviteToken("a")).not.toBe(hashInviteToken("b"));
  });
});

describe("sha256Hex", () => {
  it("known hash for empty string", () => {
    // SHA-256("") = e3b0c44298fc1c149afb...
    expect(sha256Hex("")).toMatch(/^e3b0c44/);
  });
});

describe("timingSafeCompareHex", () => {
  it("returns true for equal hex strings", () => {
    const h = hashInviteToken("test");
    expect(timingSafeCompareHex(h, h)).toBe(true);
  });

  it("returns false for different values", () => {
    const a = hashInviteToken("a");
    const b = hashInviteToken("b");
    expect(timingSafeCompareHex(a, b)).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(timingSafeCompareHex("aabb", "aabbcc")).toBe(false);
  });
});

describe("validateInviteToken", () => {
  it("returns valid: true for a correct, unexpired, unused token", () => {
    const raw = generateInviteToken();
    const hash = hashInviteToken(raw);
    const expires = new Date(Date.now() + 60_000);
    const result = validateInviteToken(raw, hash, false, expires, 0);
    expect(result.valid).toBe(true);
  });

  it("returns not_found for wrong token", () => {
    const correctRaw = generateInviteToken();
    const hash = hashInviteToken(correctRaw);
    const wrongRaw = generateInviteToken();
    const result = validateInviteToken(wrongRaw, hash, false, null, 0);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBe("not_found");
  });

  it("returns not_found when no hash is stored (legacy row)", () => {
    const result = validateInviteToken("sometoken", null, false, null, 0);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBe("not_found");
  });

  it("returns used for a consumed token", () => {
    const raw = generateInviteToken();
    const hash = hashInviteToken(raw);
    const result = validateInviteToken(raw, hash, true, null, 0);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBe("used");
  });

  it("returns expired for a past expiry", () => {
    const raw = generateInviteToken();
    const hash = hashInviteToken(raw);
    const past = new Date(Date.now() - 1000);
    const result = validateInviteToken(raw, hash, false, past, 0);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBe("expired");
  });

  it("returns rate_limited when attempt count meets MAX_TOKEN_ATTEMPTS", () => {
    const raw = generateInviteToken();
    const hash = hashInviteToken(raw);
    const result = validateInviteToken(raw, hash, false, null, MAX_TOKEN_ATTEMPTS);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBe("rate_limited");
  });

  it("rate_limited check comes before hash comparison", () => {
    // Even with a correct token, rate limit check fires first
    const raw = generateInviteToken();
    const hash = hashInviteToken(raw);
    const result = validateInviteToken(raw, hash, false, null, MAX_TOKEN_ATTEMPTS + 1);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBe("rate_limited");
  });
});
