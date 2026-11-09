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
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [versionMap, setVersionMap] = useState<Record<string, number>>({});
  const [dateMap, setDateMap] = useState<Record<string, string>>({});
  const [showAssistant, setShowAssistant] = useState(false);

  const hydratedGanttMilestones: GanttMilestone[] = ganttMilestones.map((m) => ({
    ...m,
    version: versionMap[m.id] ?? m.version,
    startDate: dateMap[m.id] ?? m.startDate,
  }));

  const handleReschedule = useCallback(
    (milestoneId: string, newStartDate: string, newVersion: number) => {
      setVersionMap((prev) => ({ ...prev, [milestoneId]: newVersion }));
      setDateMap((prev) => ({ ...prev, [milestoneId]: newStartDate }));
      // Revalidate server data (lists, budgets) so the page reconciles.
      router.refresh();
    },
    [router]
  );

  return (
    <div className="space-y-4">
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

      {/* Compact Tools Bar: Review Meetings + Toggleable Payment Assistant */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-800 bg-[#0f141e] p-4 lg:col-span-7">
          <MeetingScheduler projectId={projectId} />
        </div>

        <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-[#0f141e] p-4 lg:col-span-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-blue-400" />
                <h3 className="text-sm font-semibold text-white">AI Payment &amp; Escrow Assistant</h3>
              </div>
              <p className="mt-1 text-xs text-slate-300">
                Inspect milestone statuses, request payout readiness checks, or query escrow audit trails.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAssistant((v) => !v)}
              className="shrink-0 rounded-lg border border-blue-500/35 bg-blue-500/15 px-3 py-1.5 text-xs font-semibold text-blue-300 transition hover:bg-blue-500/25"
            >
              {showAssistant ? "Hide Assistant" : "Open Assistant"}
            </button>
          </div>
        </div>
      </div>

      {/* Expandable Payment Chat — AI-driven payment assistant */}
      {showAssistant && (
        <div className="rounded-xl border border-slate-800 bg-[#0f141e] overflow-hidden" style={{ minHeight: "340px" }}>
          <PaymentChatPanel projectId={projectId} milestones={milestones} />
        </div>
      )}
    </div>
  );
}
