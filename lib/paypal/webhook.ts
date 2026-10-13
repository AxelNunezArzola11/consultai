/**
 * PayPal webhook signature verification — LOCAL (self) method.
 *
 * Algorithm: https://developer.paypal.com/api/rest/webhooks/rest/#self-verification-method
 *   1. message = transmissionId|timeStamp|webhookId|crc32decimal(rawBody)
 *   2. Fetch + cache the PEM cert from the paypal-cert-url header.
 *   3. RSA-SHA256-verify the paypal-transmission-sig (base64) against the message.
 *
 * Why LOCAL vs POSTBACK:
 *   - Local: no network round-trip, works for simulator events.
 *   - Postback (POST /v1/notifications/verify-webhook-signature): simpler but adds
 *     latency, consumes API quota, and DOES NOT WORK for simulator/mock events per docs.
 *   Decision for Phase 1: local. Revisit only if CA pinning becomes a compliance requirement.
 *
 * Cert URL allowlist: only https on api.sandbox.paypal.com or api.paypal.com.
 * Any other hostname is rejected — prevents SSRF / cert substitution.
 *
 * Header names (exact, lowercase — verified Spike 3):
 *   paypal-transmission-id   — unique ID of the HTTP transmission
 *   paypal-transmission-time — ISO 8601 timestamp
 *   paypal-cert-url          — URL of the RSA signing certificate (PEM)
 *   paypal-transmission-sig  — base64-encoded RSA-SHA256 signature
 *   paypal-auth-algo         — always "SHA256withRSA" as of 2024
 *
 * Webhook ID format note (observed Spike 3):
 *   The PayPal Dashboard Webhook ID is a bare 17-char alphanumeric string.
 *   The "WH-XXXX" prefix you see in event.id is the EVENT id — NOT the webhook ID.
 *   Set PAYPAL_WEBHOOK_ID to the bare 17-char value from the dashboard.
 *
 * Simulator events (from PayPal docs):
 *   "For message signature verification purposes, the ID of mock webhooks is the
 *    string: WEBHOOK_ID."
 *   So simulator events will fail if PAYPAL_WEBHOOK_ID is your real ID.
 *   This is expected and correct — simulator events are not from real PayPal.
 *
 * Cert trust model:
 *   Node's built-in fetch validates the TLS cert via OS CA bundle, confirming
 *   the cert came from a server PayPal controls. The PEM is then used to verify
 *   the RSA-SHA256 signature. PayPal has not published a pinned CA fingerprint (UNVERIFIED).
 *
 * Docs:
 *   Self-verification: https://developer.paypal.com/api/rest/webhooks/rest/#self-verification-method
 *   Header names:      https://developer.paypal.com/api/rest/webhooks/rest/#message-verification
 */

import * as crypto from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Certificate cache
// ---------------------------------------------------------------------------

const CERT_CACHE_DIR = path.join(os.tmpdir(), "consultai-paypal-cert-cache");

/**
 * Exact hostname allowlist for the paypal-cert-url header.
 * Verified from sandbox (api.sandbox.paypal.com). Production uses api.paypal.com.
 * Ref: https://developer.paypal.com/api/rest/webhooks/rest/#self-verification-method
 */
const CERT_URL_ALLOWED_HOSTS = new Set([
  "api.sandbox.paypal.com",
  "api.paypal.com",
]);

async function fetchAndCacheCert(certUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(certUrl);
  } catch {
    throw new Error(`Invalid cert URL: ${certUrl}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Cert URL must use HTTPS, got: ${parsed.protocol}`);
  }
  if (!CERT_URL_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Cert URL hostname not in allowlist: ${parsed.hostname}`);
  }

  // Cache key: URL → safe filename
  const cacheKey = certUrl.replace(/[^a-z0-9]/gi, "-") + ".pem";
  const cachePath = path.join(CERT_CACHE_DIR, cacheKey);

  try {
    return await fsp.readFile(cachePath, "utf-8");
  } catch {
    // Not cached — download
    const res = await fetch(certUrl, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Cert download failed HTTP ${res.status} for: ${certUrl}`);
    }
    const pem = await res.text();
    await fsp.mkdir(CERT_CACHE_DIR, { recursive: true });
    await fsp.writeFile(cachePath, pem, "utf-8");
    return pem;
  }
}

// ---------------------------------------------------------------------------
// CRC32 (no external dependency)
// ---------------------------------------------------------------------------
// Doc: https://developer.paypal.com/api/rest/webhooks/rest/
// "The crc32 checksum for the body, in decimal form."

function buildCrc32Table(): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
}
const CRC32_TABLE = buildCrc32Table();

function crc32Decimal(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface VerifyResult {
  valid: boolean;
  reason: string;
}

/**
 * Verifies a PayPal webhook transmission using the local/self method.
 *
 * @param rawBody    Buffer of the raw HTTP body bytes — NEVER parse then re-stringify.
 * @param headers    Object containing the five PayPal transmission headers (lowercase keys).
 * @param webhookId  PAYPAL_WEBHOOK_ID from env — the bare 17-char dashboard ID.
 */
export async function verifyPayPalWebhook(
  rawBody: Buffer,
  headers: {
    "paypal-transmission-id"?: string;
    "paypal-transmission-time"?: string;
    "paypal-cert-url"?: string;
    "paypal-transmission-sig"?: string;
    "paypal-auth-algo"?: string;
  },
  webhookId: string
): Promise<VerifyResult> {
  const transmissionId = headers["paypal-transmission-id"];
  const timeStamp      = headers["paypal-transmission-time"];
  const certUrl        = headers["paypal-cert-url"];
  const sigBase64      = headers["paypal-transmission-sig"];
  const authAlgo       = headers["paypal-auth-algo"] ?? "SHA256withRSA";

  if (!transmissionId || !timeStamp || !certUrl || !sigBase64) {
    const missing = [
      !transmissionId && "paypal-transmission-id",
      !timeStamp      && "paypal-transmission-time",
      !certUrl        && "paypal-cert-url",
      !sigBase64      && "paypal-transmission-sig",
    ]
      .filter(Boolean)
      .join(", ");
    return { valid: false, reason: `Missing required headers: ${missing}` };
  }

  if (authAlgo !== "SHA256withRSA") {
    // Log but don't block — algorithm change would need a code update anyway
    console.warn("[webhook-verify] Unexpected paypal-auth-algo:", authAlgo);
  }

  // Build the verification message
  const crc = crc32Decimal(rawBody);
  const message = `${transmissionId}|${timeStamp}|${webhookId}|${crc}`;

  // Fetch the cert (cached on disk)
  let certPem: string;
  try {
    certPem = await fetchAndCacheCert(certUrl);
  } catch (e) {
    return { valid: false, reason: `Cert fetch failed: ${(e as Error).message}` };
  }

  // RSA-SHA256 verify
  try {
    const sigBuffer = Buffer.from(sigBase64, "base64");
    const verifier = crypto.createVerify("SHA256");
    verifier.update(message);
    const valid = verifier.verify(certPem, sigBuffer);
    return { valid, reason: valid ? "signature matches" : "signature mismatch" };
  } catch (e) {
    return { valid: false, reason: `Crypto error: ${(e as Error).message}` };
  }
}
