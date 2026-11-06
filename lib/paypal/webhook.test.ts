/**
 * PayPal webhook signature verification tests.
 *
 * Exercises the real local-verification math (CRC32 message construction +
 * RSA-SHA256 verify + cert-URL allowlist) with a generated RSA keypair and a
 * mocked cert download. No network access.
 *
 * This proves the verification logic; a live end-to-end check against PayPal
 * Sandbox (real transmission headers) still requires Sandbox credentials.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as crypto from "crypto";
import { verifyPayPalWebhook } from "./webhook";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeKeypair(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function crc32Decimal(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sign(
  privatePem: string,
  transmissionId: string,
  timeStamp: string,
  webhookId: string,
  body: Buffer
): string {
  const message = `${transmissionId}|${timeStamp}|${webhookId}|${crc32Decimal(body)}`;
  const signer = crypto.createSign("SHA256");
  signer.update(message);
  return signer.sign(privatePem, "base64");
}

const TRANSMISSION_ID = "test-transmission-id-001";
const TIMESTAMP = "2026-11-06T12:00:00Z";
const WEBHOOK_ID = "ABCDEF12345678901";
const BODY = Buffer.from(JSON.stringify({ id: "WH-TEST-EVENT", event_type: "TEST" }));

describe("verifyPayPalWebhook", () => {
  it("accepts a correctly signed transmission", async () => {
    const { publicPem, privatePem } = makeKeypair();
    const certUrl = `https://api.sandbox.paypal.com/v1/notifications/certs/test-${Date.now()}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => publicPem }))
    );

    const result = await verifyPayPalWebhook(
      BODY,
      {
        "paypal-transmission-id": TRANSMISSION_ID,
        "paypal-transmission-time": TIMESTAMP,
        "paypal-cert-url": certUrl,
        "paypal-transmission-sig": sign(privatePem, TRANSMISSION_ID, TIMESTAMP, WEBHOOK_ID, BODY),
        "paypal-auth-algo": "SHA256withRSA",
      },
      WEBHOOK_ID
    );

    expect(result.valid).toBe(true);
    expect(result.reason).toBe("signature matches");
  });

  it("rejects a tampered body", async () => {
    const { publicPem, privatePem } = makeKeypair();
    const certUrl = `https://api.sandbox.paypal.com/v1/notifications/certs/test-${Date.now()}-t`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => publicPem }))
    );
    const sig = sign(privatePem, TRANSMISSION_ID, TIMESTAMP, WEBHOOK_ID, BODY);

    const result = await verifyPayPalWebhook(
      Buffer.from(JSON.stringify({ id: "WH-TAMPERED", amount: "999999" })),
      {
        "paypal-transmission-id": TRANSMISSION_ID,
        "paypal-transmission-time": TIMESTAMP,
        "paypal-cert-url": certUrl,
        "paypal-transmission-sig": sig,
      },
      WEBHOOK_ID
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects a wrong webhook id", async () => {
    const { publicPem, privatePem } = makeKeypair();
    const certUrl = `https://api.sandbox.paypal.com/v1/notifications/certs/test-${Date.now()}-w`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => publicPem }))
    );
    const sig = sign(privatePem, TRANSMISSION_ID, TIMESTAMP, WEBHOOK_ID, BODY);

    const result = await verifyPayPalWebhook(
      BODY,
      {
        "paypal-transmission-id": TRANSMISSION_ID,
        "paypal-transmission-time": TIMESTAMP,
        "paypal-cert-url": certUrl,
        "paypal-transmission-sig": sig,
      },
      "WRONGWEBHOOKID123"
    );

    expect(result.valid).toBe(false);
  });

  it("rejects non-allowlisted cert hosts (SSRF protection)", async () => {
    const { privatePem } = makeKeypair();
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "pem" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyPayPalWebhook(
      BODY,
      {
        "paypal-transmission-id": TRANSMISSION_ID,
        "paypal-transmission-time": TIMESTAMP,
        "paypal-cert-url": "https://evil.example.com/cert.pem",
        "paypal-transmission-sig": sign(privatePem, TRANSMISSION_ID, TIMESTAMP, WEBHOOK_ID, BODY),
      },
      WEBHOOK_ID
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects missing headers", async () => {
    const result = await verifyPayPalWebhook(BODY, {}, WEBHOOK_ID);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Missing required headers/);
  });
});
