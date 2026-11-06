/**
 * Tests for NDA document reconstruction.
 *
 * The invite page must display the EXACT text whose SHA-256 matches the stored
 * documentHash — otherwise /api/nda/accept rejects the signature. These tests
 * prove the round-trip: generate → store hash → reconstruct → hash matches.
 */

import { describe, it, expect } from "vitest";
import { buildNdaText, NDA_TEMPLATE_VERSION } from "./generate";
import { sha256Hex } from "./invite-token";
import { reconstructNdaText } from "./reconstruct";

const PROJECT = "AI Dashboard Rebuild";
const CANDIDATE = "Alex Rivera";
const COMPANY = "Acme Corp";

describe("reconstructNdaText", () => {
  it("round-trips generation inputs back to the exact hashed text", () => {
    const sentAt = new Date();
    const date = sentAt.toISOString().slice(0, 10);
    const original = buildNdaText({
      projectTitle: PROJECT,
      companyName: COMPANY,
      candidateName: CANDIDATE,
      date,
    });

    const found = reconstructNdaText({
      projectTitle: PROJECT,
      candidateName: CANDIDATE,
      companyNameCandidates: [COMPANY, "Demo Company"],
      sentAt,
      storedHash: sha256Hex(original),
      templateVersion: NDA_TEMPLATE_VERSION,
    });

    expect(found).not.toBeNull();
    expect(found!.documentText).toBe(original);
    expect(sha256Hex(found!.documentText)).toBe(sha256Hex(original));
  });

  it("recovers legacy rows generated with the Demo Company placeholder", () => {
    const sentAt = new Date("2025-03-10T15:30:00Z");
    const original = buildNdaText({
      projectTitle: PROJECT,
      companyName: "Demo Company",
      candidateName: CANDIDATE,
      date: "2025-03-10",
    });

    const found = reconstructNdaText({
      projectTitle: PROJECT,
      candidateName: CANDIDATE,
      companyNameCandidates: [COMPANY, "Demo Company"],
      sentAt,
      storedHash: sha256Hex(original),
      templateVersion: "1.0.0",
    });

    expect(found).not.toBeNull();
    expect(found!.companyName).toBe("Demo Company");
    expect(found!.documentText).toBe(original);
  });

  it("returns null when the candidate was renamed after generation", () => {
    const sentAt = new Date();
    const original = buildNdaText({
      projectTitle: PROJECT,
      companyName: COMPANY,
      candidateName: CANDIDATE,
      date: sentAt.toISOString().slice(0, 10),
    });

    const found = reconstructNdaText({
      projectTitle: PROJECT,
      candidateName: "Someone Else",
      companyNameCandidates: [COMPANY],
      sentAt,
      storedHash: sha256Hex(original),
      templateVersion: NDA_TEMPLATE_VERSION,
    });

    expect(found).toBeNull();
  });

  it("returns null on template version drift", () => {
    const sentAt = new Date();
    const original = buildNdaText({
      projectTitle: PROJECT,
      companyName: COMPANY,
      candidateName: CANDIDATE,
      date: sentAt.toISOString().slice(0, 10),
    });

    const found = reconstructNdaText({
      projectTitle: PROJECT,
      candidateName: CANDIDATE,
      companyNameCandidates: [COMPANY],
      sentAt,
      storedHash: sha256Hex(original),
      templateVersion: "0.0.0-drifted",
    });

    expect(found).toBeNull();
  });
});
