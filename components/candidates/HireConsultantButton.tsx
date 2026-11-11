"use client";

/**
 * HireConsultantButton — client island for the candidate pipeline page.
 *
 * Hires a candidate (POST /api/candidates/hire → status "selected") and
 * refreshes the board so the card moves to the Selected column. Legal
 * from "booking_unlocked" (direct hire) and "meeting_held" (canonical
 * path); the server enforces the transition and reports the outcome.
 *
 * When no registered freelancer account matches the candidate's email or
 * GitHub handle, the hire still succeeds but a notice explains the
 * freelancer cannot see the work until they register with matching
 * identity — the dashboard keys off that match.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  candidateId: string;
  projectId: string;
  candidateName: string;
}

export function HireConsultantButton({
  candidateId,
  projectId,
  candidateName,
}: Props) {
  const router = useRouter();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; matched: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleHire() {
    if (state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const resp = await fetch("/api/candidates/hire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, projectId }),
      });

      let data: Record<string, unknown> = {};
      try {
        data = (await resp.json()) as Record<string, unknown>;
      } catch {
        setState({
          kind: "error",
          message: `Server returned status ${resp.status} without a valid JSON response.`,
        });
        return;
      }

      if (!resp.ok) {
        const errorCode = String(data.error ?? "unknown_error");
        const detail =
          errorCode === "invalid_candidate_state"
            ? `Cannot hire from the candidate's current state (${String(data.detail ?? "invalid transition")}).`
            : resp.status === 401 || resp.status === 403
              ? `Authorization required: only Company or Admin operators can hire.`
              : resp.status === 404
                ? `Candidate or project record was not found.`
                : resp.status === 429
                  ? `Too many requests. Please wait a moment and try again.`
                  : `Could not hire: ${String(data.detail ?? data.error ?? `HTTP ${resp.status}`)}.`;
        setState({ kind: "error", message: detail });
        return;
      }

      setState({
        kind: "ready",
        matched: data.freelancerAccountMatched !== false,
      });
      router.refresh();
    } catch {
      setState({
        kind: "error",
        message: "Unable to reach the server. Check your connection and try again.",
      });
    }
  }

  if (state.kind === "ready") {
    return (
      <div
        className="space-y-1.5 rounded-md border border-emerald-700/70 bg-emerald-950/40 px-2.5 py-2"
        data-testid={`hire-ready-${candidateId}`}
      >
        <p className="font-medium text-emerald-400">
          {candidateName} hired — moved to Selected.
        </p>
        {!state.matched && (
          <p className="text-[11px] text-amber-300">
            No registered freelancer account matches this candidate&apos;s
            email or GitHub handle yet — they won&apos;t see the project
            until they register with matching identity.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {state.kind === "error" && (
        <p className="text-[11px] text-red-400" role="alert">
          {state.message}
        </p>
      )}
      <button
        type="button"
        onClick={() => void handleHire()}
        disabled={state.kind === "loading"}
        data-testid={`hire-btn-${candidateId}`}
        className="w-full rounded border border-emerald-500/60 bg-emerald-950/80 px-2.5 py-1 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-900 disabled:opacity-50"
      >
        {state.kind === "loading" ? "Hiring…" : "Hire Consultant"}
      </button>
    </div>
  );
}
