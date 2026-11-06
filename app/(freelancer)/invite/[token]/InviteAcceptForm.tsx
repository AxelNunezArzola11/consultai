"use client";

/**
 * InviteAcceptForm — client island for the /invite/[token] page.
 *
 * Displays the EXACT NDA document text resolved server-side and submits its
 * SHA-256 (via WebCrypto) with the typed signature. The server only accepts
 * when the hash matches the stored document hash.
 */

import { useState } from "react";

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
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed || !typedName.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const documentHash = await sha256HexBrowser(documentText);
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
        setAccepted(true);
      } else if (resp.status === 409) {
        setAccepted(true);
      } else {
        setSubmitError(
          "This invitation link is invalid, expired, or already used. " +
            "Ask the company to issue a fresh invite link."
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
      <div className="mx-auto max-w-lg space-y-6 px-6 py-12 text-center">
        <h1 className="text-2xl font-bold">NDA Accepted</h1>
        <p className="text-muted-foreground">
          Thank you, <strong>{typedName || candidateName}</strong>. Your NDA
          has been accepted and your booking link is now unlocked.
        </p>
        <div className="space-y-1 rounded-lg border bg-muted px-4 py-3 text-left text-sm">
          <p className="font-medium">Next step:</p>
          {bookingUrl ? (
            <a
              href={bookingUrl}
              className="text-xs break-all text-blue-600 underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {bookingUrl}
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">
              The company will share your consultation booking link next.
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Demonstration only — this NDA acceptance is not legally binding.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <strong>Demonstration only:</strong> this is a demonstration
        e-signature — not legally validated. For production use, integrate a
        qualified e-signature provider.
      </div>

      <div>
        <h1 className="text-2xl font-bold">NDA Invitation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {candidateName} ({candidateEmail}) — you have been invited by{" "}
          <strong>{companyName}</strong> to sign a Non-Disclosure Agreement
          for <strong>{projectTitle}</strong>.
          {expiresAt && (
            <>
              {" "}This invitation expires{" "}
              {new Date(expiresAt).toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              .
            </>
          )}
        </p>
      </div>

      <div className="space-y-2 rounded-lg border bg-muted px-4 py-4">
        <h2 className="text-sm font-semibold">Project Overview</h2>
        <p className="text-sm text-muted-foreground">
          You are viewing a sanitized summary. The full project brief,
          acceptance criteria, and attachments unlock only after you sign.
        </p>
        <div className="rounded border bg-background px-3 py-2 text-sm">
          <p className="font-medium">{projectTitle}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {sanitizedSummary ?? "Full brief unlocked after NDA acceptance."}
          </p>
        </div>
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Non-Disclosure Agreement</h2>
          <span className="text-xs text-muted-foreground">
            Template v{templateVersion}
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto px-4 py-4">
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {documentText}
          </pre>
        </div>
      </div>

      <form onSubmit={handleAccept} className="space-y-4">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="typedName">
            Type your full name to sign
          </label>
          <input
            id="typedName"
            type="text"
            placeholder={candidateName}
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring focus:outline-none"
            required
            minLength={2}
            maxLength={120}
          />
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border"
            required
          />
          <span className="text-sm">
            I have read and agree to the terms of this Non-Disclosure
            Agreement. I understand this is a{" "}
            <strong>demonstration e-signature</strong> and not a legally
            binding contract.
          </span>
        </label>

        {submitError && (
          <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={!agreed || !typedName.trim() || isSubmitting}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {isSubmitting ? "Accepting…" : "Accept NDA & Unlock Booking"}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          Acceptance timestamp and document SHA-256 hash are recorded.
        </p>
      </form>
    </div>
  );
}
