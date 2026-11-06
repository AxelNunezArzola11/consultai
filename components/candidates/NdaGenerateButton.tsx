"use client";

/**
 * NdaGenerateButton — client island for the candidate pipeline page.
 *
 * Sends an NDA to a candidate (POST /api/nda/generate) and displays the
 * invite link ONCE to the company operator. Shows loading, success with the
 * one-time link, and honest failure states.
 */

import { useState } from "react";

interface Props {
  candidateId: string;
  projectId: string;
  candidateName: string;
}

export function NdaGenerateButton({
  candidateId,
  projectId,
  candidateName,
}: Props) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; invitePath: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleSend() {
    setState({ kind: "loading" });
    try {
      const resp = await fetch("/api/nda/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, projectId }),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      if (!resp.ok || typeof data.invitePath !== "string") {
        const detail =
          data.error === "nda_already_sent"
            ? `${candidateName} already has a sent NDA — issue its link from the demo inbox.`
            : data.error === "invalid_candidate_state"
              ? `Cannot send an NDA in the candidate's current state.`
              : `Could not send NDA (${String(data.error ?? "unknown error")}).`;
        setState({ kind: "error", message: detail });
        return;
      }
      setState({ kind: "ready", invitePath: data.invitePath });
    } catch {
      setState({ kind: "error", message: "Network error. Please try again." });
    }
  }

  if (state.kind === "ready") {
    return (
      <div className="space-y-1 rounded border border-emerald-700 bg-emerald-950/40 px-2 py-1.5">
        <p className="font-medium text-emerald-400">
          NDA sent — invite link (shown once):
        </p>
        <a
          href={state.invitePath}
          className="block break-all text-blue-400 underline"
        >
          {state.invitePath}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {state.kind === "error" && (
        <p className="text-red-400">{state.message}</p>
      )}
      <button
        type="button"
        onClick={() => void handleSend()}
        disabled={state.kind === "loading"}
        className="rounded border border-blue-400 bg-blue-950 px-2 py-1 transition-colors hover:bg-blue-900 disabled:opacity-50"
      >
        {state.kind === "loading" ? "Sending…" : "Send NDA"}
      </button>
    </div>
  );
}
