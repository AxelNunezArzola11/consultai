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
        className="w-full border-b border-emerald-200 bg-emerald-50 px-4 py-1 text-center text-xs font-medium text-emerald-800"
      >
        LIVE MODE — connected to real services (PayPal Sandbox for payments)
      </div>
    );
  }

  return (
    <div
      role="banner"
      aria-label="Offline demo mode"
      className="w-full border-b border-sky-200 bg-sky-100 px-4 py-1.5 text-center text-xs font-semibold text-sky-900"
    >
      DEMO MODE — offline fictional scenario (TechNova Solutions). All data,
      transactions, and agent runs on this page are simulated.
    </div>
  );
}
