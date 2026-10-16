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
 */

import dynamic from "next/dynamic";

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
}

// ── Component ──────────────────────────────────────────────────────────────

export function MilestonesClientExtensions({ projectId, milestones }: Props) {
  return (
    <>
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
