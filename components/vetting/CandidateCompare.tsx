"use client";

/**
 * CandidateCompare — Side-by-side comparison of 2 candidates.
 *
 * Shows:
 * - Trust scores side by side
 * - Can/can't-do matrix comparison (same requirements, both candidates)
 * - Signal counts
 */

import type { MatrixEntry, Signal } from "@/lib/vetting/signals";

interface CandidateSummary {
  id: string;
  name: string;
  trustScore: number;
  matrix: MatrixEntry[];
  signals: Signal[];
}

interface Props {
  left: CandidateSummary;
  right: CandidateSummary;
  onClose?: () => void;
}

const STATE_ICONS = { can: "✓", partial: "~", no: "✗", unknown: "?" } as const;
const STATE_COLORS = {
  can: "text-green-700",
  partial: "text-yellow-600",
  no: "text-red-600",
  unknown: "text-slate-400",
} as const;

export function CandidateCompare({ left, right, onClose }: Props) {
  // Collect all requirement IDs across both candidates
  const reqIds = Array.from(
    new Set([
      ...left.matrix.map((e) => e.requirementId),
      ...right.matrix.map((e) => e.requirementId),
    ])
  );

  // Index matrix entries by requirementId for quick lookup
  const leftByReq = Object.fromEntries(left.matrix.map((e) => [e.requirementId, e]));
  const rightByReq = Object.fromEntries(right.matrix.map((e) => [e.requirementId, e]));

  // Find a representative requirement description
  const reqDescriptions: Record<string, string> = {};
  for (const e of [...left.matrix, ...right.matrix]) {
    if (!reqDescriptions[e.requirementId]) {
      reqDescriptions[e.requirementId] = e.requirementDescription;
    }
  }

  return (
    <div className="border rounded-lg overflow-hidden text-xs">
      <div className="flex items-center justify-between px-4 py-2 bg-muted border-b">
        <h3 className="font-semibold text-sm">Side-by-Side Comparison</h3>
        {onClose && (
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            ✕
          </button>
        )}
      </div>

      {/* Header row */}
      <div className="grid grid-cols-3 border-b">
        <div className="px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wide text-[10px]">
          Requirement
        </div>
        <div className="px-3 py-2 border-l font-semibold truncate">
          {left.name}
          <span className="ml-1 text-muted-foreground font-normal">
            ({Math.round(left.trustScore * 100)})
          </span>
        </div>
        <div className="px-3 py-2 border-l font-semibold truncate">
          {right.name}
          <span className="ml-1 text-muted-foreground font-normal">
            ({Math.round(right.trustScore * 100)})
          </span>
        </div>
      </div>

      {/* Matrix rows */}
      {reqIds.map((reqId) => {
        const leftEntry = leftByReq[reqId];
        const rightEntry = rightByReq[reqId];
        const desc = reqDescriptions[reqId] ?? reqId;

        return (
          <div key={reqId} className="grid grid-cols-3 border-b last:border-b-0 hover:bg-muted/30">
            <div className="px-3 py-2 text-muted-foreground">{desc}</div>
            <div className={`px-3 py-2 border-l font-mono ${leftEntry ? STATE_COLORS[leftEntry.state] : STATE_COLORS.unknown}`}>
              {leftEntry ? STATE_ICONS[leftEntry.state] : "?"}
              {leftEntry?.evidenceSummary && (
                <span className="font-sans text-[10px] text-muted-foreground ml-1">
                  {leftEntry.evidenceSummary.slice(0, 60)}…
                </span>
              )}
            </div>
            <div className={`px-3 py-2 border-l font-mono ${rightEntry ? STATE_COLORS[rightEntry.state] : STATE_COLORS.unknown}`}>
              {rightEntry ? STATE_ICONS[rightEntry.state] : "?"}
              {rightEntry?.evidenceSummary && (
                <span className="font-sans text-[10px] text-muted-foreground ml-1">
                  {rightEntry.evidenceSummary.slice(0, 60)}…
                </span>
              )}
            </div>
          </div>
        );
      })}

      {/* Signal counts */}
      <div className="grid grid-cols-3 bg-muted/50 border-t">
        <div className="px-3 py-2 text-muted-foreground text-[10px] uppercase tracking-wide">Signals</div>
        <div className="px-3 py-2 border-l text-muted-foreground">{left.signals.length} signals</div>
        <div className="px-3 py-2 border-l text-muted-foreground">{right.signals.length} signals</div>
      </div>
    </div>
  );
}
