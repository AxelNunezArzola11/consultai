"use client";

/**
 * NdaGenerateButton — client island for the candidate pipeline page.
 *
 * Sends an NDA to a candidate (POST /api/nda/generate) and displays the
 * invite link to the company operator with Copy Link and Open Invitation
 * actions. Shows loading, success with the one-time link, and structured
 * failure states.
 */

import { useState } from "react";

interface Props {
  candidateId: string;
  projectId: string;
  candidateName: string;
  label?: string;
}

export function NdaGenerateButton({
  candidateId,
  projectId,
  candidateName,
  label = "Send NDA",
}: Props) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; invitePath: string; inviteUrl: string; reissued?: boolean; simulated?: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  async function handleSend() {
    if (state.kind === "loading") return;
    setState({ kind: "loading" });
    setCopied(false);
    try {
      const resp = await fetch("/api/nda/generate", {
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

      if (!resp.ok || typeof data.invitePath !== "string") {
        const errorCode = String(data.error ?? "unknown_error");
        const detail =
          errorCode === "nda_already_sent"
            ? `${candidateName} already has an active NDA.`
            : errorCode === "invalid_candidate_state"
              ? `Cannot send an NDA in the candidate's current state (${String(data.detail ?? "invalid transition")}).`
              : resp.status === 401 || resp.status === 403
                ? `Authorization required: only Company or Admin operators can send NDAs.`
                : resp.status === 404
                  ? `Candidate or project record was not found.`
                  : resp.status === 429
                    ? `Too many NDA requests. Please wait a moment and try again.`
                    : `Could not send NDA: ${String(data.detail ?? data.error ?? `HTTP ${resp.status}`)}.`;
        setState({ kind: "error", message: detail });
        return;
      }

      const invitePath = data.invitePath;
      const inviteUrl =
        typeof data.inviteUrl === "string" && data.inviteUrl.startsWith("http")
          ? data.inviteUrl
          : `${typeof window !== "undefined" ? window.location.origin : ""}${invitePath}`;

      setState({
        kind: "ready",
        invitePath,
        inviteUrl,
        reissued: Boolean(data.reissued),
        simulated: Boolean(data.simulated),
      });
    } catch {
      setState({
        kind: "error",
        message: "Unable to reach the server. Check your connection and try again.",
      });
    }
  }

  async function handleCopy() {
    if (state.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(state.inviteUrl || state.invitePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  if (state.kind === "ready") {
    return (
      <div
        className="space-y-1.5 rounded-md border border-emerald-700/70 bg-emerald-950/40 px-2.5 py-2"
        data-testid={`nda-ready-${candidateId}`}
      >
        <div className="flex items-center justify-between gap-1">
          <p className="font-medium text-emerald-400">
            {state.reissued ? "NDA link reissued:" : "NDA sent — invite link:"}
          </p>
          {state.simulated && (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-mono text-amber-300">
              DEMO
            </span>
          )}
        </div>
        <a
          href={state.invitePath}
          className="block break-all font-mono text-[11px] text-blue-400 underline hover:text-blue-300"
          data-testid={`nda-invite-link-${candidateId}`}
        >
          {state.invitePath}
        </a>
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded border border-emerald-700/60 bg-emerald-900/50 px-2 py-0.5 text-[11px] font-medium text-emerald-200 transition-colors hover:bg-emerald-800/60"
            data-testid={`nda-copy-link-${candidateId}`}
          >
            {copied ? "Copied!" : "Copy Link"}
          </button>
          <a
            href={state.invitePath}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-200 transition-colors hover:bg-slate-800"
          >
            Open Agreement →
          </a>
        </div>
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
        onClick={() => void handleSend()}
        disabled={state.kind === "loading"}
        data-testid={`send-nda-btn-${candidateId}`}
        className="w-full rounded border border-blue-500/60 bg-blue-950/80 px-2.5 py-1 text-xs font-medium text-blue-200 transition-colors hover:bg-blue-900 disabled:opacity-50"
      >
        {state.kind === "loading" ? "Generating NDA…" : label}
      </button>
    </div>
  );
}
