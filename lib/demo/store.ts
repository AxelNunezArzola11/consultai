/**
 * Offline demo store — isolated in-memory overlay for DEMO_MODE.
 *
 * Holds mutable copies of the fixtures so the full presentation workflow
 * (select candidate, approve proposal, sign demo NDA, run simulated agents)
 * works with zero external services. Reset restores pristine fixtures.
 *
 * Isolation guarantees:
 * - Only consulted when DEMO_MODE=true (callers branch explicitly).
 * - Never persisted, never written to any database.
 * - Per server-instance (documented in the demo guide).
 */

import { buildDemoTables, type DemoTables } from "./fixtures";
import { sha256Hex } from "@/lib/nda/invite-token";
import { buildNdaText } from "@/lib/nda/generate";

let tables: DemoTables = buildDemoTables();
let auditSeq = BigInt(9100);

/** Returns the live (mutable) demo tables. */
export function getDemoTables(): DemoTables {
  return tables;
}

/** Restores pristine fixtures. Only affects isolated demo data. */
export function resetDemoStore(): void {
  tables = buildDemoTables();
  auditSeq = BigInt(9100);
}

/** Appends an audit entry to the in-memory log. */
export function appendDemoAudit(entry: {
  entityType: string;
  entityId: string;
  event: string;
  actor: string;
  payload?: Record<string, unknown>;
}): bigint {
  auditSeq += BigInt(1);
  const id = auditSeq;
  tables.auditLog.unshift({
    id,
    entityType: entry.entityType,
    entityId: entry.entityId,
    event: entry.event,
    actor: entry.actor,
    payload: { ...entry.payload, simulated: true },
    createdAt: new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Demo NDA tokens ("demo-nda-<ndaId>:<random>")
// ---------------------------------------------------------------------------
// Demo invite links are clearly-namespaced, single-use within the store, and
// validated WITHOUT any hashing shortcut leaks: the store keeps the expected
// raw token only in memory (never persisted), and acceptance still binds the
// submitted document hash to the stored demo document hash.

const demoTokenByNda = new Map<string, string>();

function randomDemoToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DemoInvite {
  ndaId: string;
  invitePath: string;
  tokenExpiresAt: Date;
}

/** Issues a fresh single-use demo invite for a demo NDA. */
export function issueDemoInvite(ndaId: string): DemoInvite | null {
  const nda = tables.ndas.find((n) => n.id === ndaId);
  if (!nda || (nda.status !== "sent" && nda.status !== "pending")) return null;
  const raw = `demo-${randomDemoToken()}`;
  demoTokenByNda.set(ndaId, raw);
  nda.inviteTokenHash = sha256Hex(raw);
  nda.inviteTokenUsed = false;
  nda.inviteTokenRateLimit = 0;
  nda.inviteTokenExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  return {
    ndaId,
    invitePath: `/invite/${ndaId}:${raw}`,
    tokenExpiresAt: nda.inviteTokenExpiresAt,
  };
}

/** Validates a demo invite token (single-use, in-memory). */
export function consumeDemoInvite(
  ndaId: string,
  rawToken: string
): "ok" | "invalid" | "used" | "expired" {
  const nda = tables.ndas.find((n) => n.id === ndaId);
  if (!nda) return "invalid";
  if (nda.status === "accepted") return "used";
  if (
    nda.inviteTokenExpiresAt &&
    new Date() > new Date(nda.inviteTokenExpiresAt)
  ) {
    return "expired";
  }
  if (nda.inviteTokenUsed) return "used";
  const expected = demoTokenByNda.get(ndaId);
  if (!expected || expected !== rawToken) return "invalid";
  return "ok";
}

/** Marks a demo invite consumed after successful acceptance. */
export function markDemoInviteUsed(ndaId: string): void {
  const nda = tables.ndas.find((n) => n.id === ndaId);
  if (nda) {
    nda.inviteTokenUsed = true;
    demoTokenByNda.delete(ndaId);
  }
}

/** Builds the exact demo NDA text for a demo NDA row (hash-bound). */
export function demoNdaText(ndaId: string): string | null {
  const nda = tables.ndas.find((n) => n.id === ndaId);
  const candidate = nda
    ? tables.candidates.find((c) => c.id === nda.candidateId)
    : undefined;
  const project = nda
    ? tables.projects.find((p) => p.id === nda.projectId)
    : undefined;
  const company = project
    ? tables.companies.find((c) => c.id === project.companyId)
    : undefined;
  if (!nda || !candidate || !project) return null;
  const date = new Date(nda.sentAt ?? nda.createdAt)
    .toISOString()
    .slice(0, 10);
  return buildNdaText({
    projectTitle: project.title,
    companyName: company?.name ?? "Demo Company",
    candidateName: candidate.name,
    date,
  });
}

/** Creates a demo NDA row for a demo candidate (demo-mode generate). */
export function createDemoNda(candidateId: string, projectId: string): {
  ndaId: string;
  invitePath: string;
  tokenExpiresAt: Date;
} | null {
  const candidate = tables.candidates.find(
    (c) => c.id === candidateId && c.projectId === projectId
  );
  if (!candidate) return null;
  const ndaId = `demo-nda-${candidateId}-${Date.now()}`;
  const now = new Date();
  tables.ndas.push({
    id: ndaId,
    candidateId,
    projectId,
    templateVersion: "1.0.0",
    contentHash: "",
    pdfUrl: null,
    inviteToken: null,
    inviteTokenHash: null,
    inviteTokenUsed: false,
    inviteTokenRateLimit: 0,
    inviteTokenExpiresAt: null,
    status: "sent",
    sentAt: now,
    acceptedAt: null,
    acceptedName: null,
    acceptedIp: null,
    documentHash: "",
    expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
    createdAt: now,
  });
  const text = demoNdaText(ndaId);
  const row = tables.ndas.find((n) => n.id === ndaId)!;
  row.documentHash = text ? sha256Hex(text) : "";
  row.contentHash = row.documentHash;
  candidate.status = "nda_sent";
  candidate.updatedAt = now;
  const invite = issueDemoInvite(ndaId);
  if (!invite) return null;
  return invite;
}

/** Records a demo NDA acceptance (document hash must match exactly). */
export function acceptDemoNda(
  ndaId: string,
  rawToken: string,
  typedName: string,
  documentHash: string
): "ok" | "invalid" | "used" | "expired" | "hash_mismatch" {
  const check = consumeDemoInvite(ndaId, rawToken);
  if (check !== "ok") return check;
  const nda = tables.ndas.find((n) => n.id === ndaId)!;
  if (documentHash !== nda.documentHash) return "hash_mismatch";
  nda.status = "accepted";
  nda.acceptedAt = new Date();
  nda.acceptedName = typedName;
  nda.acceptedIp = "127.0.0.1 (demo)";
  markDemoInviteUsed(ndaId);
  const candidate = tables.candidates.find((c) => c.id === nda.candidateId);
  if (candidate) {
    candidate.status = "nda_signed";
    candidate.updatedAt = new Date();
  }
  appendDemoAudit({
    entityType: "nda",
    entityId: ndaId,
    event: "NDA_ACCEPTED",
    actor: typedName,
    payload: { candidateId: nda.candidateId, projectId: nda.projectId },
  });
  return "ok";
}
