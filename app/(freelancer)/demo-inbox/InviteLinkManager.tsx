"use client";

/**
 * InviteLinkManager — client island for the demo inbox.
 *
 * Issues a fresh single-use invite link via POST /api/nda/regenerate and
 * displays it ONCE to the operator (the raw token is never stored). Shows
 * loading, success, and failure states honestly.
 */

import { useState } from "react";

interface Props {
  ndaId: string;
}

export function InviteLinkManager({ ndaId }: Props) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; invitePath: string; expiresAt: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  async function handleIssue() {
    setState({ kind: "loading" });
    setCopied(false);
    try {
      const resp = await fetch("/api/nda/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ndaId }),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      if (resp.status === 403) {
        setState({
          kind: "error",
          message:
            "Issuing invite links requires the company or admin role. Use Switch Role to continue as a company operator.",
        });
        return;
      }
      if (!resp.ok || typeof data.invitePath !== "string") {
        setState({
          kind: "error",
          message: `Could not issue a link (${String(data.error ?? "unknown error")}).`,
        });
        return;
      }
      setState({
        kind: "ready",
        invitePath: data.invitePath,
        expiresAt: String(data.tokenExpiresAt ?? ""),
      });
    } catch {
      setState({ kind: "error", message: "Network error. Please try again." });
    }
  }

  async function handleCopy(path: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (state.kind === "ready") {
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          Fresh single-use invite link (shown once — previous links are revoked):
        </p>
        <a
          href={state.invitePath}
          className="text-xs break-all text-blue-600 underline dark:text-blue-400"
        >
          {state.invitePath}
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={state.invitePath}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open invitation
          </a>
          <button
            type="button"
            onClick={() => void handleCopy(state.invitePath)}
            className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={() => void handleIssue()}
            className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
          >
            Revoke & reissue
          </button>
        </div>
        {state.expiresAt && (
          <p className="text-xs text-muted-foreground">
            Link expires:{" "}
            {new Date(state.expiresAt).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Secure single-use link. Issue a fresh link to open this invitation —
        raw tokens are never stored.
      </p>
      {state.kind === "error" && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.message}
        </p>
      )}
      <button
        type="button"
        onClick={() => void handleIssue()}
        disabled={state.kind === "loading"}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {state.kind === "loading" ? "Issuing…" : "Issue invite link"}
      </button>
    </div>
  );
}
