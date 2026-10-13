/**
 * PayPal REST client — shared fetch wrapper for all PayPal API calls.
 *
 * Env vars:
 *   PAYPAL_CLIENT_ID       — from PayPal Developer Dashboard (required)
 *   PAYPAL_CLIENT_SECRET   — from PayPal Developer Dashboard (required)
 *   PAYPAL_ENV             — "sandbox" | "live" (required; used to derive default base URL)
 *   PAYPAL_BASE_URL        — override the API base URL; if absent, derived from PAYPAL_ENV:
 *                              sandbox → https://api-m.sandbox.paypal.com
 *                              live    → https://api-m.paypal.com
 *
 * Doc: https://developer.paypal.com/api/rest/authentication/
 * Doc: https://developer.paypal.com/api/rest/requests/#http-request-headers
 */

/** API base URLs per environment. */
const PAYPAL_BASE_URLS: Record<string, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live:    "https://api-m.paypal.com",
};

/**
 * Returns the PayPal API base URL.
 * Prefers PAYPAL_BASE_URL if set. Falls back to PAYPAL_ENV-derived URL.
 * Throws only if neither PAYPAL_BASE_URL nor a recognised PAYPAL_ENV is set.
 */
export function getPayPalBaseUrl(): string {
  const explicit = process.env.PAYPAL_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const env  = (process.env.PAYPAL_ENV ?? "sandbox").toLowerCase();
  const derived = PAYPAL_BASE_URLS[env];
  if (derived) return derived;

  throw new Error(
    `PAYPAL_BASE_URL is not set and PAYPAL_ENV ("${env}") is not recognised. ` +
      `Set PAYPAL_ENV=sandbox or PAYPAL_ENV=live in Vercel env vars.`
  );
}

/**
 * Obtains a client-credentials OAuth access token.
 * Doc: https://developer.paypal.com/api/rest/authentication/
 *
 * Tokens are NOT cached here — callers should cache if needed.
 * Vercel serverless processes are short-lived; token lifetime (6–9h) exceeds typical
 * function duration, so per-request token fetch is acceptable for the demo.
 */
export async function getAccessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is not set.");
  }

  const base = getPayPalBaseUrl();
  const credentials = Buffer.from(`${id}:${secret}`).toString("base64");

  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PayPal OAuth failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Safely parses a Response body as JSON.
 * Returns a fallback object if the body is empty or not valid JSON.
 * Use this instead of `res.json()` whenever the response may have an empty body
 * (e.g. PayPal 5xx errors sometimes return no body).
 */
export async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _raw: text };
  }
}

/**
 * Generic PayPal API fetch.
 * Obtains a fresh token and includes standard headers.
 *
 * @param path    e.g. "/v2/checkout/orders"
 * @param init    RequestInit (method, body, headers merged with defaults)
 * @param idempotencyKey  optional PayPal-Request-Id for idempotency
 */
export async function paypalFetch(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {}
): Promise<Response> {
  const base = getPayPalBaseUrl();
  const token = await getAccessToken();

  const { idempotencyKey, ...fetchInit } = init;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(idempotencyKey ? { "PayPal-Request-Id": idempotencyKey } : {}),
    ...(fetchInit.headers as Record<string, string> | undefined ?? {}),
  };

  return fetch(`${base}${path}`, {
    ...fetchInit,
    headers,
    cache: "no-store",
  });
}
