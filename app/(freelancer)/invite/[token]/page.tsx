/**
 * NDA Acceptance page — /invite/[token]
 *
 * Server component: resolves the token to real NDA / project / company /
 * candidate data (including the exact NDA text whose hash binds acceptance)
 * and renders distinct honest states for expired, used, already-accepted,
 * and invalid tokens.
 */

export const dynamic = "force-dynamic";

import Link from "next/link";
import { resolveNdaDetails, type NdaDetailsError } from "@/lib/nda/details";
import { InviteAcceptForm } from "./InviteAcceptForm";

const ERROR_COPY: Record<
  NdaDetailsError,
  { title: string; body: string; badge: string; tone: "emerald" | "amber" | "rose" }
> = {
  already_accepted: {
    title: "NDA Already Accepted",
    body: "This Non-Disclosure Agreement has already been accepted and recorded on the project audit ledger. No further action is required.",
    badge: "VERIFIED · ALREADY ACCEPTED",
    tone: "emerald",
  },
  token_expired: {
    title: "Invitation Expired",
    body: "This NDA invitation link has expired. Please ask the disclosing company to issue a fresh invitation link from the Candidate Pipeline.",
    badge: "EXPIRED TOKEN",
    tone: "amber",
  },
  already_used: {
    title: "Link Already Used",
    body: "This single-use invitation link was already consumed. If you have not yet completed signature verification, ask the company to reissue the NDA link.",
    badge: "SINGLE-USE CONSUMED",
    tone: "amber",
  },
  rate_limited: {
    title: "Too Many Verification Attempts",
    body: "This invitation is temporarily locked after repeated failed attempts. Ask the company to issue a fresh invitation link.",
    badge: "RATE LIMITED",
    tone: "rose",
  },
  invalid_or_expired_token: {
    title: "Invitation Unavailable",
    body: "This NDA invitation link is invalid or no longer available. Ask the company to issue a fresh invite link.",
    badge: "INVALID TOKEN",
    tone: "rose",
  },
  reconstruction_failed: {
    title: "Document Verification Failed",
    body: "This NDA record cannot be displayed because cryptographic hash verification did not match. Ask the company to regenerate the invitation.",
    badge: "HASH MISMATCH",
    tone: "rose",
  },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const decoded = decodeURIComponent(token);
  const result = await resolveNdaDetails(decoded);

  if (!result.ok) {
    const copy = ERROR_COPY[result.error];
    const toneStyles =
      copy.tone === "emerald"
        ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-300"
        : copy.tone === "amber"
          ? "border-amber-500/40 bg-amber-950/30 text-amber-300"
          : "border-rose-500/40 bg-rose-950/30 text-rose-300";

    return (
      <div className="mx-auto max-w-xl px-6 py-14">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-8 text-center shadow-2xl">
          <span
            className={`inline-block rounded-full border px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider ${toneStyles}`}
          >
            {copy.badge}
          </span>
          <h1 className="mt-4 text-2xl font-bold text-white">{copy.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            {copy.body}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link
              href="/freelancer"
              className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
            >
              Open Freelancer Portal →
            </Link>
            <Link
              href="/"
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            >
              Back to ConsultAI Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <InviteAcceptForm token={decoded} {...result.details} />;
}
