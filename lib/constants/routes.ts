/**
 * Single source of truth for all API paths and absolute URL construction.
 *
 * Rule (Spike 8): Every webhook/callback URL registered with an external service
 * (PayPal, Cal.com, QStash) MUST be built using APP_BASE_URL from this file.
 * Never use window.location, VERCEL_URL, VERCEL_BRANCH_URL, or hardcoded strings.
 *
 * VERCEL_URL resolves to per-deployment URLs that are protected by Vercel Authentication —
 * external services cannot authenticate there. APP_BASE_URL must be set to the stable
 * production alias (e.g. https://consultai.vercel.app).
 *
 * This module throws at load time if APP_BASE_URL is missing, so misconfigured deployments
 * fail fast during the first request rather than silently routing webhooks to the wrong place.
 */

/** All API route paths (relative). Import from here; never hardcode strings elsewhere. */
export const ROUTES = {
  // PayPal
  PAYPAL_CREATE_ORDER: "/api/paypal/create-order",
  PAYPAL_CAPTURE_ORDER: "/api/paypal/capture-order",
  PAYPAL_PAYOUT: "/api/paypal/payout",
  PAYPAL_WEBHOOK: "/api/paypal/webhook",

  // QStash — NOTE: path is /receive not /receiver (Spike 8 root cause fix)
  QSTASH_RECEIVE: "/api/qstash/receive",
  /** @deprecated Use QSTASH_RECEIVE */
  QSTASH_TIMEOUT: "/api/qstash/receive",

  // Cal.com
  CAL_WEBHOOK: "/api/cal/webhook",

  // NDA (Phase 4)
  NDA_GENERATE: "/api/nda/generate",
  NDA_ACCEPT: "/api/nda/accept",

  // Invite (freelancer-facing)
  INVITE: "/invite",

  // GitHub
  GITHUB_VERIFY_PR: "/api/github/verify-pr",

  // Elastic
  ELASTIC_SEARCH: "/api/elastic/search",
  ELASTIC_AUDIT: "/api/elastic/audit",

  // SSE
  SSE_PIPELINE: "/api/sse/pipeline",
  SSE_ACTIVITY: "/api/sse/activity",

  // Agent
  AGENT_BRIEF: "/api/agent/brief",
  AGENT_VETTING: "/api/agent/vetting",
  AGENT_NDA: "/api/agent/nda",
  AGENT_DELIVERY: "/api/agent/delivery",

  // Demo controls (DEMO_MODE only)
  DEMO_SIMULATE_NDA_SIGNED: "/api/demo/simulate-nda-signed",
  DEMO_SIMULATE_CANCELLATION: "/api/demo/simulate-cancellation",
} as const;

/**
 * Returns APP_BASE_URL from environment, validated.
 * Throws immediately if the variable is missing — fail fast, never silently misconfigure.
 *
 * Usage (server-side only):
 *   import { getBaseUrl } from "@/lib/constants/routes";
 *   const webhookUrl = getBaseUrl() + ROUTES.PAYPAL_WEBHOOK;
 */
export function getBaseUrl(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    throw new Error(
      "APP_BASE_URL is not set. " +
        "Set it in .env.local (development) or in Vercel env vars (production) " +
        "to the stable production alias, e.g. https://consultai.vercel.app. " +
        "Never use VERCEL_URL — it resolves to per-deployment URLs that are " +
        "Vercel Authentication-protected and cannot receive external webhooks."
    );
  }
  // Strip trailing slash for safe concatenation with paths that start with /
  return base.replace(/\/$/, "");
}

/**
 * Builds the full absolute URL for a given route path.
 * Throws if APP_BASE_URL is not set.
 *
 * @example
 *   buildWebhookUrl(ROUTES.PAYPAL_WEBHOOK)
 *   // => "https://consultai.vercel.app/api/paypal/webhook"
 */
export function buildWebhookUrl(path: string): string {
  return getBaseUrl() + path;
}
