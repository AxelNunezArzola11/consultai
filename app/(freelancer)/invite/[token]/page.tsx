/**
 * NDA Acceptance page — /invite/[token]
 *
 * Server component: resolves the token to real NDA / project / company /
 * candidate data (including the exact NDA text whose hash binds acceptance)
 * and renders distinct honest states for expired, used, and invalid tokens.
 *
 * DEMO DISCLAIMER: Explicitly marked as a non-legally-validated e-signature
 * demonstration.
 */

export const dynamic = "force-dynamic";

import Link from "next/link";
import { resolveNdaDetails, type NdaDetailsError } from "@/lib/nda/details";
import { InviteAcceptForm } from "./InviteAcceptForm";

const ERROR_COPY: Record<NdaDetailsError, { title: string; body: string }> = {
  invalid_or_expired_token: {
    title: "Invitation Unavailable",
    body: "This invitation link is invalid or no longer available. Ask the company to issue a fresh invite link.",
  },
  token_expired: {
    title: "Invitation Expired",
    body: "This invitation link has expired. Ask the company to issue a fresh invite link.",
  },
  already_used: {
    title: "Link Already Used",
    body: "This single-use invitation link was already consumed. If you did not sign yet, ask the company for a fresh link.",
  },
  already_accepted: {
    title: "NDA Already Accepted",
    body: "This NDA was already accepted. No further action is needed.",
  },
  rate_limited: {
    title: "Too Many Attempts",
    body: "This invitation is temporarily locked after too many attempts. Ask the company to issue a fresh invite link.",
  },
  reconstruction_failed: {
    title: "Invitation Unavailable",
    body: "This NDA record cannot be displayed securely (document verification failed). Ask the company to regenerate the invitation.",
  },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Next.js decodes %3A but a raw ":" in the path segment arrives as-is.
  const decoded = decodeURIComponent(token);
  const result = await resolveNdaDetails(decoded);

  if (!result.ok) {
    const copy = ERROR_COPY[result.error];
    return (
      <div className="mx-auto max-w-lg space-y-4 px-6 py-12 text-center">
        <h1 className="text-xl font-bold">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
        <p className="text-xs text-muted-foreground">
          <Link href="/" className="underline">
            Back to ConsultAI home
          </Link>
        </p>
      </div>
    );
  }

  return <InviteAcceptForm token={decoded} {...result.details} />;
}
