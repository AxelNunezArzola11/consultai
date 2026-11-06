"use client";

/**
 * DemoResetButton — client island for the Demo Control Center.
 *
 * Calls POST /api/demo/reset (demo mode only, company/admin role) and shows
 * loading / success / failure states honestly. Only affects isolated demo data.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DemoResetButton() {
  const router = useRouter();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "done" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleReset() {
    setState({ kind: "loading" });
    try {
      const resp = await fetch("/api/demo/reset", { method: "POST" });
      const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      if (!resp.ok) {
        setState({
          kind: "error",
          message:
            resp.status === 403
              ? "Demo reset requires the company or admin role (or DEMO mode)."
              : `Reset failed (${String(data.error ?? resp.status)}).`,
        });
        return;
      }
      setState({ kind: "done" });
      router.refresh();
    } catch {
      setState({ kind: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <div className="space-y-2">
      {state.kind === "done" && (
        <p className="rounded-md border border-emerald-700 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
          Demo fixtures restored to their pristine state.
        </p>
      )}
      {state.kind === "error" && (
        <p className="rounded-md border border-red-700 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {state.message}
        </p>
      )}
      <button
        type="button"
        onClick={() => void handleReset()}
        disabled={state.kind === "loading"}
        className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {state.kind === "loading" ? "Resetting…" : "Reset demo fixtures"}
      </button>
      <p className="text-xs text-slate-500">
        Restores the pristine TechNova scenario. Only affects isolated demo data.
      </p>
    </div>
  );
}
