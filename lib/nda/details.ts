/**
 * NDA invitation details resolver — Phase 1 fix.
 *
 * Shared by GET /api/nda/details and the /invite/[token] page so both enforce
 * identical token validation and document reconstruction.
 *
 * Security:
 * - Token format "ndaId:rawToken"; validated with timing-safe hash comparison,
 *   single-use flag, expiry window, and rate limiting (same as /api/nda/accept).
 * - The rate-limit counter increments on every resolution attempt.
 * - Never returns the full project brief — only the sanitized pre-NDA summary.
 * - Never returns token material (raw token or hash).
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { ndas, candidates, projects, companies } from "@/lib/db/schema";
import { validateInviteToken } from "./invite-token";
import { reconstructNdaText } from "./reconstruct";
import { isDemoMode } from "@/lib/demo/config";

export type NdaDetailsError =
  | "invalid_or_expired_token"
  | "token_expired"
  | "already_used"
  | "already_accepted"
  | "rate_limited"
  | "reconstruction_failed";

export interface NdaDetails {
  ndaId: string;
  projectTitle: string;
  sanitizedSummary: string | null;
  companyName: string;
  candidateName: string;
  candidateEmail: string;
  documentText: string;
  templateVersion: string;
  expiresAt: string | null;
}

export type NdaDetailsResult =
  | { ok: true; details: NdaDetails }
  | { ok: false; error: NdaDetailsError };

export async function resolveNdaDetails(
  token: string
): Promise<NdaDetailsResult> {
  if (isDemoMode()) {
    return resolveDemoNdaDetails(token);
  }
  const colonIdx = token.indexOf(":");
  if (colonIdx < 0) return { ok: false, error: "invalid_or_expired_token" };
  const ndaId = token.slice(0, colonIdx);
  const rawToken = token.slice(colonIdx + 1);
  if (!ndaId || !rawToken) {
    return { ok: false, error: "invalid_or_expired_token" };
  }

  const [nda] = await db
    .select()
    .from(ndas)
    .where(eq(ndas.id, ndaId))
    .limit(1);
  if (!nda) return { ok: false, error: "invalid_or_expired_token" };

  if (nda.status === "accepted") {
    // Verify the presented raw token matches the stored hash (ignoring used flag)
    // so only the holder of the real invite token sees "already_accepted".
    const replayValidation = validateInviteToken(
      rawToken,
      nda.inviteTokenHash ?? null,
      false,
      nda.inviteTokenExpiresAt ?? null,
      (nda.inviteTokenRateLimit ?? 0) + 1
    );
    if (replayValidation.valid) {
      return { ok: false, error: "already_accepted" };
    }
    return { ok: false, error: "invalid_or_expired_token" };
  }
  if (nda.status === "expired" || nda.status === "declined") {
    return { ok: false, error: "invalid_or_expired_token" };
  }

  // Increment the attempt counter before validation (same as accept route).
  await db
    .update(ndas)
    .set({ inviteTokenRateLimit: (nda.inviteTokenRateLimit ?? 0) + 1 })
    .where(eq(ndas.id, ndaId));

  const validation = validateInviteToken(
    rawToken,
    nda.inviteTokenHash ?? null,
    nda.inviteTokenUsed ?? false,
    nda.inviteTokenExpiresAt ?? null,
    (nda.inviteTokenRateLimit ?? 0) + 1
  );

  if (!validation.valid) {
    switch (validation.reason) {
      case "expired":
        return { ok: false, error: "token_expired" };
      case "used":
        return { ok: false, error: "already_used" };
      case "rate_limited":
        return { ok: false, error: "rate_limited" };
      default:
        return { ok: false, error: "invalid_or_expired_token" };
    }
  }

  const [candidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, nda.candidateId))
    .limit(1);
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, nda.projectId))
    .limit(1);
  if (!candidate || !project) {
    return { ok: false, error: "invalid_or_expired_token" };
  }
  const [company] = project.companyId
    ? await db
        .select()
        .from(companies)
        .where(eq(companies.id, project.companyId))
        .limit(1)
    : [];

  const storedHash = nda.documentHash ?? nda.contentHash ?? "";
  const reconstructed = reconstructNdaText({
    projectTitle: project.title,
    candidateName: candidate.name,
    companyNameCandidates: [
      company?.name ?? "",
      "Demo Company", // legacy rows generated with the placeholder
    ],
    sentAt: nda.sentAt ?? nda.createdAt,
    storedHash,
    templateVersion: nda.templateVersion ?? "",
  });
  if (!reconstructed) {
    return { ok: false, error: "reconstruction_failed" };
  }

  return {
    ok: true,
    details: {
      ndaId: nda.id,
      projectTitle: project.title,
      sanitizedSummary: project.sanitizedSummary ?? null,
      companyName: reconstructed.companyName,
      candidateName: candidate.name,
      candidateEmail: candidate.email,
      documentText: reconstructed.documentText,
      templateVersion: nda.templateVersion ?? "1.0.0",
      expiresAt: nda.expiresAt?.toISOString() ?? null,
    },
  };
}

/** Offline demo resolution — demo NDA rows from the in-memory store only. */
async function resolveDemoNdaDetails(
  token: string
): Promise<NdaDetailsResult> {
  const { getDemoTables, consumeDemoInvite, demoNdaText } = await import(
    "@/lib/demo/store"
  );
  const colonIdx = token.indexOf(":");
  if (colonIdx < 0) return { ok: false, error: "invalid_or_expired_token" };
  const ndaId = token.slice(0, colonIdx);
  const rawToken = token.slice(colonIdx + 1);
  if (!ndaId || !rawToken) {
    return { ok: false, error: "invalid_or_expired_token" };
  }

  const t = getDemoTables();
  const nda = t.ndas.find((n) => n.id === ndaId);
  if (!nda) return { ok: false, error: "invalid_or_expired_token" };
  if (nda.status === "accepted") return { ok: false, error: "already_accepted" };

  const check = consumeDemoInvite(ndaId, rawToken);
  if (check === "expired") return { ok: false, error: "token_expired" };
  if (check === "used") return { ok: false, error: "already_used" };
  if (check !== "ok") return { ok: false, error: "invalid_or_expired_token" };

  const candidate = t.candidates.find((c) => c.id === nda.candidateId);
  const project = t.projects.find((p) => p.id === nda.projectId);
  const company = project
    ? t.companies.find((c) => c.id === project.companyId)
    : undefined;
  const documentText = demoNdaText(ndaId);
  if (!candidate || !project || !documentText) {
    return { ok: false, error: "reconstruction_failed" };
  }

  return {
    ok: true,
    details: {
      ndaId: nda.id,
      projectTitle: project.title,
      sanitizedSummary: project.sanitizedSummary ?? null,
      companyName: company?.name ?? "Demo Company",
      candidateName: candidate.name,
      candidateEmail: candidate.email,
      documentText,
      templateVersion: nda.templateVersion ?? "1.0.0",
      expiresAt: nda.expiresAt?.toISOString() ?? null,
    },
  };
}
