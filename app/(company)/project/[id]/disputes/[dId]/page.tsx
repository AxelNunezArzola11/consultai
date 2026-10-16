/**
 * /project/[id]/disputes/[dId] — Dispute detail page
 *
 * Shows the DisputeView for a specific dispute.
 * The [dId] is our internal disputes.id (not the PayPal dispute ID).
 */

import { DisputeView } from "@/components/payments/DisputeView";

interface PageProps {
  params: Promise<{ id: string; dId: string }>;
}

export default async function DisputePage({ params }: PageProps) {
  const { dId } = await params;

  return (
    <main>
      <DisputeView disputeId={dId} />
    </main>
  );
}
