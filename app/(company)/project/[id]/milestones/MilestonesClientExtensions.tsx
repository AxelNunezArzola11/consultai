"use client";

/**
 * MilestonesClientExtensions — client-side extensions for the milestones page.
 *
 * Contains all dynamically-loaded client components that cannot be
 * imported with `ssr: false` directly in a Server Component in Next.js 16+.
 *
 * - CandidateComplianceBar
 * - MeetingScheduler
 * - PaymentChatPanel
 * - GanttPanelLazy (Step 3 — feature-flagged via NEXT_PUBLIC_GANTT_ENABLED)
 */

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { GanttMilestone } from "@/components/canvas/GanttPanel";

// CandidateComplianceBar — lazy client fetch
const CandidateComplianceBar = dynamic(
  () => import("@/components/vetting/CandidateComplianceBar").then((m) => ({
    default: m.CandidateComplianceBar,
  })),
  { ssr: false }
);

// MeetingScheduler — interactive client form
const MeetingScheduler = dynamic(
  () => import("@/components/shared/MeetingScheduler").then((m) => ({
    default: m.MeetingScheduler,
  })),
  { ssr: false }
);

// PaymentChatPanel — AI payment assistant
const PaymentChatPanel = dynamic(
  () => import("@/components/payments/PaymentChatPanel").then((m) => ({
    default: m.PaymentChatPanel,
  })),
  { ssr: false }
);

// GanttPanelLazy — Bryntum Gantt (feature-flagged, ssr:false inside)
const GanttPanelLazy = dynamic(
  () => import("@/components/canvas/GanttPanelLazy").then((m) => ({
    default: m.GanttPanelLazy,
  })),
  { ssr: false }
);

// ── Types ──────────────────────────────────────────────────────────────────

interface MilestoneSummary {
  id: string;
  title: string;
  status: string;
  budgetUsd: string;
}

interface Props {
  projectId: string;
  milestones: MilestoneSummary[];
  /** Full milestone data for the Gantt (includes startDate, dueDate, version) */
  ganttMilestones?: GanttMilestone[];
}

// ── Component ──────────────────────────────────────────────────────────────

export function MilestonesClientExtensions({ projectId, milestones, ganttMilestones = [] }: Props) {
  // Track version updates from successful reschedules so subsequent drops use
  // the correct expectedVersion without a full page refresh.
  const [versionMap, setVersionMap] = useState<Record<string, number>>({});

  const hydratedGanttMilestones: GanttMilestone[] = ganttMilestones.map((m) => ({
    ...m,
    version: versionMap[m.id] ?? m.version,
  }));

  const handleReschedule = useCallback(
    (milestoneId: string, _newStartDate: string, newVersion: number) => {
      setVersionMap((prev) => ({ ...prev, [milestoneId]: newVersion }));
    },
    []
  );

  return (
    <>
      {/* Gantt chart — shown only when NEXT_PUBLIC_GANTT_ENABLED=true */}
      {ganttMilestones.length > 0 && (
        <GanttPanelLazy
          projectId={projectId}
          milestones={hydratedGanttMilestones}
          onReschedule={handleReschedule}
        />
      )}

      {/* Candidate compliance overview */}
      <CandidateComplianceBar projectId={projectId} />

      {/* Review meetings scheduler */}
      <div className="rounded-xl border bg-muted/30 p-4">
        <MeetingScheduler projectId={projectId} />
      </div>

      {/* Payment Chat — AI-driven payment assistant */}
      <div className="rounded-xl border overflow-hidden" style={{ minHeight: "360px" }}>
        <PaymentChatPanel projectId={projectId} milestones={milestones} />
      </div>
    </>
  );
}
