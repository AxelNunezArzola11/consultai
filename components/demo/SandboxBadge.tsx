"use client";

/**
 * SandboxBadge — fixed banner visible on every page.
 * Reminds all demo viewers that PayPal credentials are sandbox only.
 * No production transactions are processed.
 */
export function SandboxBadge() {
  return (
    <div
      role="banner"
      aria-label="PayPal Sandbox Mode"
      className="w-full bg-amber-950/35 border-b border-amber-500/20 text-amber-200/90 text-[11px] font-medium text-center py-1 px-4 z-50"
    >
      ⚠️ PayPal Sandbox Mode — no real transactions
    </div>
  );
}
