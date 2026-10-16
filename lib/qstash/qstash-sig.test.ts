/**
 * QStash signature verification tests — Phase 4
 *
 * Tests the QStash HMAC-SHA256 signature check logic in isolation.
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// Extract the signature validator (mirrors the implementation)
// ---------------------------------------------------------------------------

function verifyQStashSignature(
  rawBody: string,
  signatureHeader: string | null,
  currentKey: string | null,
  nextKey: string | null
): boolean {
  if (!signatureHeader) return false;
  if (!currentKey && !nextKey) return false;

  const prefix = "v1:";
  if (!signatureHeader.startsWith(prefix)) return false;
  const sigBase64 = signatureHeader.slice(prefix.length);

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sigBase64, "base64url");
  } catch {
    return false;
  }

  const { timingSafeEqual } = require("crypto");

  for (const key of [currentKey, nextKey]) {
    if (!key) continue;
    const expected = createHmac("sha256", key).update(rawBody).digest();
    if (expected.length === sigBytes.length) {
      try {
        if (timingSafeEqual(expected, sigBytes)) return true;
      } catch {
        // continue
      }
    }
  }

  return false;
}

function makeSignature(body: string, key: string): string {
  const hmac = createHmac("sha256", key).update(body).digest();
  return "v1:" + hmac.toString("base64url");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CURRENT_KEY = "qstash-current-key-abc";
const NEXT_KEY = "qstash-next-key-xyz";

describe("QStash signature verification", () => {
  it("accepts a valid signature with current key", () => {
    const body = JSON.stringify({ type: "NDA_EXPIRY", entityId: "nda-1" });
    const sig = makeSignature(body, CURRENT_KEY);
    expect(verifyQStashSignature(body, sig, CURRENT_KEY, NEXT_KEY)).toBe(true);
  });

  it("accepts a valid signature with next key (key rotation)", () => {
    const body = JSON.stringify({ type: "NDA_EXPIRY", entityId: "nda-1" });
    const sig = makeSignature(body, NEXT_KEY);
    expect(verifyQStashSignature(body, sig, CURRENT_KEY, NEXT_KEY)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const originalBody = JSON.stringify({ type: "NDA_EXPIRY", entityId: "nda-1" });
    const sig = makeSignature(originalBody, CURRENT_KEY);
    const tamperedBody = JSON.stringify({ type: "NO_SHOW_CHECK", entityId: "nda-1" });
    expect(verifyQStashSignature(tamperedBody, sig, CURRENT_KEY, NEXT_KEY)).toBe(false);
  });

  it("rejects a wrong key", () => {
    const body = JSON.stringify({ type: "NDA_EXPIRY", entityId: "nda-1" });
    const sig = makeSignature(body, "wrong-key");
    expect(verifyQStashSignature(body, sig, CURRENT_KEY, NEXT_KEY)).toBe(false);
  });

  it("rejects missing signature header", () => {
    const body = JSON.stringify({ type: "NDA_EXPIRY", entityId: "nda-1" });
    expect(verifyQStashSignature(body, null, CURRENT_KEY, NEXT_KEY)).toBe(false);
  });

  it("rejects wrong prefix (not v1:)", () => {
    const body = JSON.stringify({ type: "NDA_EXPIRY", entityId: "nda-1" });
    const sig = "v2:" + createHmac("sha256", CURRENT_KEY).update(body).digest("base64url");
    expect(verifyQStashSignature(body, sig, CURRENT_KEY, NEXT_KEY)).toBe(false);
  });

  it("rejects when no keys are configured", () => {
    const body = JSON.stringify({ type: "NDA_EXPIRY", entityId: "nda-1" });
    const sig = makeSignature(body, CURRENT_KEY);
    expect(verifyQStashSignature(body, sig, null, null)).toBe(false);
  });
});
