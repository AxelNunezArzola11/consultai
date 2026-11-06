"use client";

/**
 * Admin section error boundary — renders when a page throws (e.g. the
 * database is unreachable). Honest, actionable, and recoverable via retry.
 */

import { useEffect } from "react";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin] Page error:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <div
        role="alert"
        className="rounded-2xl border border-red-500/40 bg-red-950/30 p-6 text-center"
      >
        <h1 className="text-lg font-bold text-white">This page could not load</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-300">
          {error.message ||
            "An unexpected error occurred while loading live data."}{" "}
          No data is shown because the page failed — not because it is empty.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500"
          >
            Try again
          </button>
          <a
            href="/api/health"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-700 px-4 py-2 font-medium text-slate-200 hover:bg-slate-800"
          >
            Check system status
          </a>
        </div>
      </div>
    </div>
  );
}
