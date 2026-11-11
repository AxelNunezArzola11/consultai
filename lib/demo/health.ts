/**
 * System health probe — distinguishes the four presentation states:
 * - simulated:   offline DEMO_MODE (fixtures only, no probes run)
 * - connected:   database reachable and responding
 * - degraded:    database reachable but an integration is unconfigured
 * - unavailable: database unreachable, misconfigured, or timed out
 *
 * Probes are bounded (5s) and read-only (SELECT 1). No credentials or
 * connection strings are ever included in the result.
 */

import { neon } from "@neondatabase/serverless";
import { isDemoMode } from "@/lib/demo/config";
import { withTimeout } from "@/lib/db/with-timeout";

export type SystemStatus = "simulated" | "connected" | "degraded" | "unavailable";

export interface SystemHealth {
  status: SystemStatus;
  mode: "LIVE" | "DEMO";
  latencyMs: number | null;
  checks: {
    database: "ok" | "timeout" | "missing_config" | "error" | "skipped_demo";
    paypal: "configured" | "missing" | "skipped_demo";
    ai: "configured" | "missing" | "skipped_demo";
    backend: "reachable" | "unreachable" | "unconfigured" | "skipped_demo";
  };
  /**
   * GitHub API credential presence (vetting needs GITHUB_TOKEN for its
   * 5000 req/hr quota; anonymous quota exhausts on shared serverless IPs).
   * Boolean-only — never a secret value.
   */
  github: "configured" | "missing" | "skipped_demo";
  /** Active Groq model id for vetting/extraction (not secret). Null in demo. */
  llmModel: string | null;
  detail: string;
}

const PROBE_TIMEOUT_MS = 5000;

async function probeBackend(): Promise<SystemHealth["checks"]["backend"]> {
  const base = process.env.RENDER_BACKEND_URL ?? process.env.BACKEND_URL;
  if (!base) return "unconfigured";
  try {
    const res = await withTimeout(
      fetch(`${base.replace(/\/$/, "")}/health`, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
      PROBE_TIMEOUT_MS,
      "backend health probe"
    );
    return res.ok ? "reachable" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function getSystemHealth(): Promise<SystemHealth> {
  if (isDemoMode()) {
    return {
      status: "simulated",
      mode: "DEMO",
      latencyMs: null,
      checks: {
        database: "skipped_demo",
        paypal: "skipped_demo",
        ai: "skipped_demo",
        backend: "skipped_demo",
      },
      github: "skipped_demo",
      llmModel: null,
      detail:
        "Offline demo mode: serving fictional TechNova fixtures. No external service is contacted.",
    };
  }

  const started = Date.now();
  let dbCheck: SystemHealth["checks"]["database"] = "error";
  const url = process.env.DATABASE_URL;
  if (!url) {
    dbCheck = "missing_config";
  } else {
    try {
      const sql = neon(url);
      await withTimeout(sql`SELECT 1 AS ok`, PROBE_TIMEOUT_MS, "database probe");
      dbCheck = "ok";
    } catch (err) {
      dbCheck = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error";
    }
  }
  const latencyMs = Date.now() - started;

  const paypal =
    process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
      ? "configured"
      : ("missing" as const);
  const ai = process.env.GROQ_API_KEY ? "configured" : ("missing" as const);
  const backend = await probeBackend();
  const github =
    process.env.GITHUB_TOKEN || process.env.GITHUB_PAT
      ? ("configured" as const)
      : ("missing" as const);
  const llmModel = process.env.LLM_GROQ_MODEL ?? "qwen/qwen3-32b";

  if (dbCheck !== "ok") {
    const reason =
      dbCheck === "missing_config"
        ? "DATABASE_URL is not configured."
        : dbCheck === "timeout"
          ? `Database did not respond within ${PROBE_TIMEOUT_MS}ms.`
          : "Database query failed.";
    return {
      status: "unavailable",
      mode: "LIVE",
      latencyMs,
      checks: { database: dbCheck, paypal, ai, backend },
      github,
      llmModel,
      detail: `Database unavailable: ${reason} Live data cannot load — switch to DEMO mode for the offline scenario.`,
    };
  }

  const degraded =
    paypal === "missing" ||
    ai === "missing" ||
    backend === "unreachable" ||
    github === "missing";
  return {
    status: degraded ? "degraded" : "connected",
    mode: "LIVE",
    latencyMs,
    checks: { database: dbCheck, paypal, ai, backend },
    github,
    llmModel,
    detail: degraded
      ? "Database connected, but at least one integration (PayPal, AI, GitHub, backend) is unconfigured or unreachable."
      : "All systems connected.",
  };
}
