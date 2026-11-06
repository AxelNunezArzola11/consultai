/**
 * Centralized demo-mode configuration.
 *
 * Two presentation modes:
 * - LIVE (default): real Neon database, real backend, PayPal Sandbox.
 * - DEMO (DEMO_MODE=true): fully offline. Typed deterministic fixtures served
 *   from an isolated in-memory store. No external service is contacted, no
 *   record is written to any production database, and every simulated artifact
 *   is labeled as simulated in the UI.
 *
 * Demo WRITE controls (the "simulate NDA/cancellation" buttons) are a third,
 * separate concern: they mutate a REAL database and are therefore enabled
 * only against a live database in development (or with ALLOW_DEMO_WRITES).
 * They are never available in offline demo mode (there is no database).
 */

export const DEMO_MODE_ENV_VAR = "DEMO_MODE";

/** True when the app serves offline demo fixtures instead of live data. */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

/**
 * True when the demo write-controls (live-DB event simulation) may be shown.
 * Requires a live database connection — never true in offline demo mode.
 */
export function areDemoWriteControlsEnabled(): boolean {
  if (isDemoMode()) return false;
  return (
    process.env.NODE_ENV === "development" ||
    process.env.ALLOW_DEMO_WRITES === "true"
  );
}

/** Human-readable mode label for banners and headers. */
export function demoModeLabel(): "LIVE" | "DEMO" {
  return isDemoMode() ? "DEMO" : "LIVE";
}

// ---------------------------------------------------------------------------
// Canonical fixture IDs (stable across every route)
// ---------------------------------------------------------------------------

export const DEMO_IDS = {
  company: "demo-company-technova",
  project: "demo-project-saas",
  milestones: {
    requirements: "demo-ms-requirements",
    frontend: "demo-ms-frontend",
    backend: "demo-ms-backend",
    integration: "demo-ms-integration",
    qa: "demo-ms-qa",
    deploy: "demo-ms-deploy",
  },
  candidates: {
    maya: "demo-cand-maya",
    raj: "demo-cand-raj",
    lena: "demo-cand-lena",
  },
  dispute: "demo-dispute-1",
  schedulingProposal: "demo-sched-1",
  paymentProposal: "demo-payprop-1",
  approval: "demo-approval-1",
  ndaMaya: "demo-nda-maya",
  ndaRaj: "demo-nda-raj",
} as const;
