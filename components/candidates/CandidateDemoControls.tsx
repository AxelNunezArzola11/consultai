"use client";

/**
 * CandidateDemoControls — client island for the candidate pipeline page.
 *
 * Sends JSON requests to the demo simulation APIs (matching their contracts),
 * shows per-action loading / success / failure states, and refreshes the
 * server-rendered pipeline after each action.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";

interface CandidateRef {
  id: string;
  name: string;
}

interface Props {
  projectId: string;
  ndaSentCandidates: CandidateRef[];
  bookedCandidates: CandidateRef[];
}

type ActionState =
  | { kind: "idle" }
  | { kind: "loading"; candidateId: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export function CandidateDemoControls({
  projectId,
  ndaSentCandidates,
  bookedCandidates,
}: Props) {
  const router = useRouter();
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

  async function runSimulation(
    apiPath: string,
    candidate: CandidateRef,
    verb: string
  ) {
    setAction({ kind: "loading", candidateId: candidate.id });
    try {
      const resp = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: candidate.id, projectId }),
      });
      const data = (await resp.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!resp.ok) {
        setAction({
          kind: "error",
          message: `Failed to simulate for ${candidate.name} (${String(data.error ?? resp.status)}).`,
        });
        return;
      }
      setAction({
        kind: "done",
        message: `Simulated ${verb} for ${candidate.name}. Pipeline refreshed.`,
      });
      router.refresh();
    } catch {
      setAction({
        kind: "error",
        message: `Network error while simulating for ${candidate.name}.`,
      });
    }
  }

  const empty =
    ndaSentCandidates.length === 0 && bookedCandidates.length === 0;

  return (
    <div className="space-y-3 rounded-lg border border-orange-800/60 bg-orange-950/40 p-4">
      <div className="flex items-center gap-2">
        <Badge variant="destructive" className="text-xs">
          DEMO ONLY
        </Badge>
        <h2 className="text-sm font-semibold">Demo Controls</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        These buttons simulate real events for demonstration. Disabled in
        production.
      </p>

      {action.kind === "done" && (
        <p className="rounded-md border border-emerald-700 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
          {action.message}
        </p>
      )}
      {action.kind === "error" && (
        <p className="rounded-md border border-red-700 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {action.message}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {ndaSentCandidates.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={action.kind === "loading"}
            onClick={() =>
              void runSimulation(
                "/api/demo/simulate-nda-signed",
                c,
                "NDA signed"
              )
            }
            className="rounded border border-orange-400 bg-orange-100 px-3 py-1.5 text-xs transition-colors hover:bg-orange-200 disabled:opacity-50 dark:bg-orange-900 dark:hover:bg-orange-800"
          >
            {action.kind === "loading" && action.candidateId === c.id
              ? "Simulating…"
              : `Simulate NDA Signed: ${c.name}`}
          </button>
        ))}
        {bookedCandidates.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={action.kind === "loading"}
            onClick={() =>
              void runSimulation(
                "/api/demo/simulate-cancellation",
                c,
                "cancellation"
              )
            }
            className="rounded border border-orange-400 bg-orange-100 px-3 py-1.5 text-xs transition-colors hover:bg-orange-200 disabled:opacity-50 dark:bg-orange-900 dark:hover:bg-orange-800"
          >
            {action.kind === "loading" && action.candidateId === c.id
              ? "Simulating…"
              : `Simulate Cancellation: ${c.name}`}
          </button>
        ))}
        {empty && (
          <p className="text-xs text-muted-foreground">
            No candidates in NDA_SENT or BOOKED state to simulate.
          </p>
        )}
      </div>
    </div>
  );
}
