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
      className="w-full bg-amber-50 border-b border-amber-200 text-amber-800 text-xs font-medium text-center py-1.5 px-4 z-50"
    >
      ⚠️ PayPal Sandbox Mode — no real transactions
    </div>
  );
}
