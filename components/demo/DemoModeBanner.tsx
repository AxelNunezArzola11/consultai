/**
 * DemoModeBanner — server-rendered banner, visible on every page.
 *
 * Makes the active presentation mode unmistakable:
 * - DEMO MODE: offline fixtures, simulated data, no external services.
 * - LIVE MODE: real database and integrations (compact indicator).
 */

import { isDemoMode } from "@/lib/demo/config";

export function DemoModeBanner() {
  if (!isDemoMode()) {
    return (
      <div
        role="status"
        aria-label="Live mode"
        className="w-full border-b border-emerald-500/20 bg-emerald-950/40 px-4 py-1 text-center text-[11px] font-medium tracking-wide text-emerald-300"
      >
        <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" />
        LIVE MODE — connected to real services (PayPal Sandbox for payments)
      </div>
    );
  }

  return (
    <div
      role="banner"
      aria-label="Offline demo mode"
      className="w-full border-b border-sky-500/20 bg-sky-950/45 px-4 py-1 text-center text-[11px] font-medium tracking-wide text-sky-200"
    >
      <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-400 align-middle" />
      DEMO MODE — offline fictional scenario (TechNova Solutions). All data,
      transactions, and agent runs on this page are simulated.
    </div>
  );
}
