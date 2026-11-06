/**
 * Shared honest-rejection helper for offline DEMO_MODE.
 *
 * External integrations (PayPal, GitHub, Cal.com, QStash, live LLM) are
 * unreachable by design in demo mode. Callers return this response instead
 * of attempting the integration — never a simulated success.
 */

import { NextResponse } from "next/server";

export function demoBlocked(feature: string): NextResponse {
  return NextResponse.json(
    {
      error: "demo_mode_unavailable",
      detail:
        `${feature} requires live external services, which are unreachable in offline demo mode. ` +
        "Switch to LIVE mode with valid credentials to use this feature.",
    },
    { status: 503 }
  );
}
