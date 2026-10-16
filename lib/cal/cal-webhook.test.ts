/**
 * Cal.com webhook signature validation tests — Phase 4
 *
 * Tests the signature check logic in isolation (no DB, no HTTP server).
 * Extracts the pure validation function for testing.
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// Extract the signature validator (mirrors the implementation)
// ---------------------------------------------------------------------------

function validateCalSignature(
  rawBody: Buffer,
  signature: string | null,
  secret: string
): boolean {
  if (!secret) return false;
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  const sigHex = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  if (sigHex.length !== expected.length) return false;

  const { timingSafeEqual } = require("crypto");
  try {
    return timingSafeEqual(Buffer.from(sigHex, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SECRET = "test-webhook-secret-abc";

function makePayload(obj: object): Buffer {
  return Buffer.from(JSON.stringify(obj), "utf8");
}

function sign(body: Buffer, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("Cal.com webhook signature validation", () => {
  it("accepts a valid signature", () => {
    const body = makePayload({ triggerEvent: "BOOKING_CREATED", uid: "abc123" });
    const sig = sign(body, SECRET);
    expect(validateCalSignature(body, sig, SECRET)).toBe(true);
  });

  it("accepts signature without sha256= prefix", () => {
    const body = makePayload({ triggerEvent: "BOOKING_CREATED", uid: "abc123" });
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(validateCalSignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const originalBody = makePayload({ triggerEvent: "BOOKING_CREATED", uid: "abc123" });
    const sig = sign(originalBody, SECRET);
    const tamperedBody = makePayload({ triggerEvent: "BOOKING_CANCELLED", uid: "abc123" });
    expect(validateCalSignature(tamperedBody, sig, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const body = makePayload({ triggerEvent: "BOOKING_CREATED", uid: "abc123" });
    const sig = sign(body, "wrong-secret");
    expect(validateCalSignature(body, sig, SECRET)).toBe(false);
  });

  it("rejects missing signature (null)", () => {
    const body = makePayload({ triggerEvent: "BOOKING_CREATED", uid: "abc123" });
    expect(validateCalSignature(body, null, SECRET)).toBe(false);
  });

  it("rejects empty signature", () => {
    const body = makePayload({ triggerEvent: "BOOKING_CREATED", uid: "abc123" });
    expect(validateCalSignature(body, "", SECRET)).toBe(false);
  });

  it("rejects malformed hex in signature", () => {
    const body = makePayload({ triggerEvent: "BOOKING_CREATED", uid: "abc123" });
    expect(validateCalSignature(body, "sha256=GGGG", SECRET)).toBe(false);
  });
});
