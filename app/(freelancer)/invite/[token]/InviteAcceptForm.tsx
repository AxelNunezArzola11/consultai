"use client";

/**
 * InviteAcceptForm — client island for the /invite/[token] page.
 *
 * Displays the EXACT NDA document text resolved server-side and submits its
 * SHA-256 (via WebCrypto) with the typed signature. The server only accepts
 * when the hash matches the stored document hash.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

async function sha256HexBrowser(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface Props {
  token: string;
  projectTitle: string;
  companyName: string;
  candidateName: string;
  candidateEmail: string;
  sanitizedSummary: string | null;
  documentText: string;
  templateVersion: string;
  expiresAt: string | null;
}

export function InviteAcceptForm({
  token,
  projectTitle,
  companyName,
  candidateName,
  candidateEmail,
  sanitizedSummary,
  documentText,
  templateVersion,
  expiresAt,
}: Props) {
  const [typedName, setTypedName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [acceptedAtIso, setAcceptedAtIso] = useState<string | null>(null);
  const [computedHash, setComputedHash] = useState<string>("");
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    sha256HexBrowser(documentText)
      .then((hash) => {
        if (active) setComputedHash(hash);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [documentText]);

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed || !typedName.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const documentHash =
        computedHash || (await sha256HexBrowser(documentText));
      const resp = await fetch("/api/nda/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          typedName: typedName.trim(),
          agreed: true,
          documentHash,
        }),
      });
      if (resp.status === 200) {
        const data = (await resp.json()) as { bookingUrl?: string | null };
        setBookingUrl(data.bookingUrl ?? null);
        setAcceptedAtIso(new Date().toISOString());
        setAccepted(true);
      } else if (resp.status === 409) {
        setAcceptedAtIso(new Date().toISOString());
        setAccepted(true);
      } else {
        const errData = await resp.json().catch(() => null);
        setSubmitError(
          errData?.message ||
            "This invitation link is invalid, expired, or already used. Ask the company to issue a fresh invite link."
        );
      }
    } catch {
      setSubmitError("A network error occurred. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (accepted) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="rounded-2xl border border-emerald-500/40 bg-slate-900/95 p-8 shadow-2xl">
          <div className="flex items-center justify-between">
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 font-mono text-[11px] font-bold uppercase text-emerald-300">
              ✓ NDA Accepted &amp; Cryptographically Bound
            </span>
            <span className="font-mono text-xs text-slate-400">
              Template v{templateVersion}
            </span>
          </div>

          <h1 className="mt-4 text-2xl font-bold text-white">
            NDA Acceptance Recorded
          </h1>
          <p className="mt-2 text-sm text-slate-300">
            Thank you, <strong>{typedName || candidateName}</strong>. Your
            Mutual Non-Disclosure Agreement with{" "}
            <strong className="text-white">{companyName}</strong> for{" "}
            <strong className="text-white">{projectTitle}</strong> has been
            verified and persisted.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/90 p-4 text-xs sm:grid-cols-2">
            <div>
              <span className="text-slate-500">Signatory:</span>
              <div className="mt-0.5 font-semibold text-slate-200">
                {typedName || candidateName} ({candidateEmail})
              </div>
            </div>
            <div>
              <span className="text-slate-500">Recorded Timestamp:</span>
              <div className="mt-0.5 font-mono text-slate-200">
                {acceptedAtIso
                  ? new Date(acceptedAtIso).toLocaleString("en-US", {
                      dateStyle: "medium",
                      timeStyle: "medium",
                    })
                  : "Recorded"}
              </div>
            </div>
            {computedHash && (
              <div className="sm:col-span-2">
                <span className="text-slate-500">Bound Document SHA-256:</span>
                <div className="mt-0.5 break-all font-mono text-[11px] text-emerald-400">
                  {computedHash}
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-left text-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-blue-400">
              Next Step — Consultation &amp; Technical Onboarding
            </p>
            {bookingUrl ? (
              <a
                href={bookingUrl}
                className="mt-1 block break-all text-xs text-blue-400 underline hover:text-blue-300"
                target="_blank"
                rel="noopener noreferrer"
              >
                {bookingUrl}
              </a>
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                Your candidate pipeline status is now{" "}
                <strong className="text-emerald-400">nda_signed</strong>. The
                disclosing company can now unlock full project specifications and
                schedule your technical consultation.
              </p>
            )}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
            <p className="text-[11px] text-slate-500">
              Demonstration e-signature record — not a substitute for qualified
              legal counsel.
            </p>
            <Link
              href="/freelancer"
              className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              Go to Freelancer Portal →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <div className="rounded-xl border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
        <strong>Demonstration E-Signature Notice:</strong> This agreement uses
        SHA-256 content-addressed verification for evaluation purposes and is
        not a legally binding contract.
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rounded bg-blue-500/20 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-blue-400">
            Mutual Non-Disclosure Agreement
          </span>
          <span className="font-mono text-xs text-slate-400">
            Template v{templateVersion}
          </span>
        </div>

        <h1 className="mt-3 text-2xl font-bold text-white">NDA Invitation</h1>
        <p className="mt-1 text-sm text-slate-300">
          <strong className="text-white">{candidateName}</strong> (
          {candidateEmail}) — you have been invited by{" "}
          <strong className="text-blue-400">{companyName}</strong> to review and
          sign a Mutual Non-Disclosure Agreement for{" "}
          <strong className="text-white">{projectTitle}</strong>.
        </p>

        {/* Metadata Strip */}
        <div className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 text-xs sm:grid-cols-3">
          <div>
            <span className="text-slate-500">Disclosing Company</span>
            <div className="mt-0.5 font-semibold text-slate-200">
              {companyName}
            </div>
          </div>
          <div>
            <span className="text-slate-500">Receiving Consultant</span>
            <div className="mt-0.5 font-semibold text-slate-200">
              {candidateName}
            </div>
          </div>
          <div>
            <span className="text-slate-500">Invitation Expiry</span>
            <div className="mt-0.5 font-mono text-slate-300">
              {expiresAt
                ? new Date(expiresAt).toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : "72 hours from issue"}
            </div>
          </div>
        </div>

        {/* Project Overview */}
        <div className="mt-5 space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Sanitized Project Overview
            </h2>
            <span className="font-mono text-[10px] text-slate-500">
              Full WBS &amp; repo unlock post-signature
            </span>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 px-3.5 py-2.5 text-sm">
            <p className="font-semibold text-white">{projectTitle}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              {sanitizedSummary ??
                "Full project brief, acceptance criteria, and repository details unlock immediately after NDA acceptance."}
            </p>
          </div>
        </div>

        {/* NDA Full Text */}
        <div className="mt-5 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/80 px-4 py-2.5">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Agreement Text
            </h2>
            {computedHash && (
              <span className="font-mono text-[10px] text-slate-400">
                SHA-256: {computedHash.slice(0, 16)}…
              </span>
            )}
          </div>
          <div className="max-h-72 overflow-y-auto px-4 py-4">
            <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-300">
              {documentText}
            </pre>
          </div>
        </div>

        {/* Signature Form */}
        <form onSubmit={handleAccept} className="mt-6 space-y-4">
          <div>
            <label
              className="block text-xs font-semibold text-slate-200"
              htmlFor="typedName"
            >
              Type your full name to sign
            </label>
            <input
              id="typedName"
              type="text"
              placeholder={candidateName}
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              required
              minLength={2}
              maxLength={120}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-3 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-950 text-blue-600"
              required
            />
            <span>
              I have read and agree to the terms of this Non-Disclosure
              Agreement. I understand this is a{" "}
              <strong className="text-white">demonstration e-signature</strong>{" "}
              bound to the SHA-256 hash of the agreement text above.
            </span>
          </label>

          {submitError && (
            <p
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-200"
            >
              {submitError}
            </p>
          )}

          <button
            type="submit"
            disabled={!agreed || !typedName.trim() || isSubmitting}
            className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 disabled:opacity-50"
          >
            {isSubmitting ? "Accepting…" : "Accept NDA & Unlock Booking"}
          </button>

          <p className="text-center font-mono text-[11px] text-slate-500">
            Acceptance timestamp, signatory name, and SHA-256 document hash are
            recorded in the append-only audit log.
          </p>
        </form>
      </div>
    </div>
  );
}
