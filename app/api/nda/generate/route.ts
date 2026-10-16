/**
 * POST /api/nda/generate
 *
 * Generates an NDA for a candidate, stores the PDF, creates the invite link.
 *
 * Request body: { candidateId: string, projectId: string }
 *
 * Returns: { ndaId, inviteUrl, contentHash }
 *
 * Security:
 * - Only the SHA-256 hash of the invite token is stored in DB
 * - The raw token appears only in the returned inviteUrl (sent to demo-inbox)
 * - Full brief is NOT included in this response
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4
 */

import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { ndas, candidates, projects } from "@/lib/db/schema";
import { generateNdaPdf } from "@/lib/nda/generate";
import {
  generateInviteToken,
  hashInviteToken,
  tokenExpiresAt,
  ndaExpiresAt,
} from "@/lib/nda/invite-token";
import { buildWebhookUrl } from "@/lib/constants/routes";
import { ROUTES } from "@/lib/constants/routes";
import { writeAuditLog } from "@/lib/db/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { candidateId?: string; projectId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { candidateId, projectId } = body;
  if (!candidateId || !projectId) {
    return NextResponse.json(
      { error: "candidateId and projectId are required" },
      { status: 400 }
    );
  }

  // Fetch candidate and project
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!candidate || !project) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Generate NDA PDF
  const { pdfBytes, documentHash } = await generateNdaPdf({
    projectTitle: project.title,
    companyName: "Demo Company", // Phase 4 — company name from project.company in production
    candidateName: candidate.name,
  });

  // Generate invite token — store only the hash
  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const tokenExpiry = tokenExpiresAt();
  const ndaExpiry = ndaExpiresAt();

  // Store NDA record
  // pdfBytes stored as base64 data URL for demo (no blob storage in this phase)
  const pdfDataUrl =
    "data:application/pdf;base64," +
    Buffer.from(pdfBytes).toString("base64");

  const ndaId = nanoid();

  await db.insert(ndas).values({
    id: ndaId,
    candidateId,
    projectId,
    templateVersion: "1.0.0",
    contentHash: documentHash,
    documentHash,
    pdfUrl: pdfDataUrl,
    inviteTokenHash: tokenHash,
    inviteTokenUsed: false,
    inviteTokenRateLimit: 0,
    inviteTokenExpiresAt: tokenExpiry,
    status: "sent",
    sentAt: new Date(),
    expiresAt: ndaExpiry,
  });

  // Build invite URL — raw token in URL, only hash in DB
  const inviteUrl = `${buildWebhookUrl(ROUTES.NDA_ACCEPT).replace("/api/nda/accept", "")}/invite/${rawToken}`;

  // Audit log
  await writeAuditLog({
    entityType: "nda",
    entityId: ndaId,
    event: "NDA_SENT",
    actor: "system",
    payload: {
      candidateId,
      projectId,
      expiresAt: ndaExpiry.toISOString(),
      tokenExpiresAt: tokenExpiry.toISOString(),
    },
  });

  return NextResponse.json({
    ndaId,
    inviteUrl,
    contentHash: documentHash,
  });
}
