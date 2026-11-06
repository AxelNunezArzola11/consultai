/**
 * NDA document reconstruction — Phase 1 fix.
 *
 * The exact NDA text shown to a candidate must hash to the stored documentHash
 * (the accept route binds acceptance to that hash). The text itself is not
 * stored, so this module re-derives it deterministically from the generation
 * inputs and SELF-VERIFIES against the stored hash.
 *
 * Variation handling (all verified by exact hash match — no false positives):
 * - Company name: current real name first, then the legacy "Demo Company"
 *   placeholder used by older rows.
 * - Date: the generation day (from NDA sentAt), plus adjacent days to cover a
 *   midnight rollover between text generation and row insert.
 *
 * Returns null when no exact reconstruction matches — callers must surface an
 * honest failure, never accept on a mismatched document.
 */

import { buildNdaText, NDA_TEMPLATE_VERSION } from "./generate";
import { sha256Hex } from "./invite-token";

export interface ReconstructNdaInput {
  projectTitle: string;
  candidateName: string;
  /** Candidate company names, preferred first. */
  companyNameCandidates: string[];
  /** When the NDA row was created (generation moment). */
  sentAt: Date;
  /** Stored SHA-256 of the exact generated text. */
  storedHash: string;
  /** Stored template version — must match the current template. */
  templateVersion: string | null;
}

export interface ReconstructedNda {
  documentText: string;
  companyName: string;
  date: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dateCandidates(sentAt: Date): string[] {
  const base = sentAt.getTime();
  const days = [
    new Date(base).toISOString().slice(0, 10),
    new Date(base - DAY_MS).toISOString().slice(0, 10),
    new Date(base + DAY_MS).toISOString().slice(0, 10),
  ];
  return [...new Set(days)];
}

export function reconstructNdaText(
  input: ReconstructNdaInput
): ReconstructedNda | null {
  if (input.templateVersion !== NDA_TEMPLATE_VERSION) return null;
  if (!input.storedHash) return null;

  const companies = [...new Set(input.companyNameCandidates.filter(Boolean))];
  if (companies.length === 0) return null;

  for (const companyName of companies) {
    for (const date of dateCandidates(input.sentAt)) {
      const documentText = buildNdaText({
        projectTitle: input.projectTitle,
        companyName,
        candidateName: input.candidateName,
        date,
      });
      if (sha256Hex(documentText) === input.storedHash) {
        return { documentText, companyName, date };
      }
    }
  }
  return null;
}
