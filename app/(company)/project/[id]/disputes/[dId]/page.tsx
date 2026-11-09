/**
 * /project/[id]/disputes/[dId] — Dispute detail page
 *
 * Shows the DisputeView for a specific dispute.
 * The [dId] is our internal disputes.id (not the PayPal dispute ID).
 */

import { DisputeView } from "@/components/payments/DisputeView";
import { requireProjectAccess } from "@/lib/auth/guards";

interface PageProps {
  params: Promise<{ id: string; dId: string }>;
}

export default async function DisputePage({ params }: PageProps) {
  const { id, dId } = await params;
  // Role gate + company ownership (live); cross-company -> notFound, before rendering.
  await requireProjectAccess(id);

  return (
    <main>
      <DisputeView disputeId={dId} />
    </main>
  );
}
