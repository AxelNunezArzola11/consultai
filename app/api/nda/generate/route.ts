/**
 * POST /api/nda/generate
 *
 * Generates an NDA for a candidate, stores the PDF, creates the invite link,
 * and transitions the candidate to nda_sent.
 *
 * Request body: { candidateId: string, projectId: string }
 *
 * Returns: { ndaId, invitePath, inviteUrl, contentHash }
 *
 * Security:
 * - Company or admin role required (server-side).
 * - Only the SHA-256 hash of the invite token is stored in DB.
 * - The raw token appears only in the returned inviteUrl/invitePath, shown
 *   once to the operator — never stored, never logged.
 * - Invite format is "ndaId:rawToken" (matches /api/nda/accept validation).
 * - Full brief is NOT included in this response.
 *
 * Phase 4 — Source: consultai-plan.md §4 Phase 4
 */

import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { ndas, candidates, projects, companies } from "@/lib/db/schema";
import { generateNdaPdf } from "@/lib/nda/generate";
import {
  generateInviteToken,
  hashInviteToken,
  tokenExpiresAt,
  ndaExpiresAt,
} from "@/lib/nda/invite-token";
import { getBaseUrl } from "@/lib/constants/routes";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { writeAuditLog } from "@/lib/db/audit";
import {
  assertCandidateTransition,
  CandidateTransitionError,
} from "@/lib/state-machines/candidate-pipeline";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

function absoluteBase(req: NextRequest): string {
  try {
    return getBaseUrl();
  } catch {
    return req.nextUrl.origin;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: generating NDAs requires the company or admin role." },
      { status: 403 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("nda-generate", ip, 20, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: { candidateId?: string; projectId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { candidateId, projectId } = body;
  if (!candidateId || typeof candidateId !== "string" || candidateId.length > 100 ||
      !projectId || typeof projectId !== "string" || projectId.length > 100) {
    return NextResponse.json(
      { error: "candidateId and projectId are required" },
      { status: 400 }
    );
  }
  const ndaActor = session ? `${session.role}:${session.userId}` : `${role}-operator`;

  try {
    if (isDemoMode()) {
      const { createDemoNda, issueDemoInvite, getDemoTables } = await import(
        "@/lib/demo/store"
      );
      const t = getDemoTables();
      const demoCandidate = t.candidates.find(
        (c) => c.id === candidateId && c.projectId === projectId
      );
      if (!demoCandidate) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      if (session?.role === "company" && session.companyId) {
        const demoProject = t.projects.find((p) => p.id === projectId);
        if (!demoProject || demoProject.companyId !== session.companyId) {
          return NextResponse.json({ error: "forbidden" }, { status: 403 });
        }
      }
      if (demoCandidate.status === "nda_sent") {
        const existingNda = t.ndas.find(
          (n) => n.candidateId === candidateId && n.status === "sent"
        );
        if (existingNda) {
          const reissued = issueDemoInvite(existingNda.id);
          if (reissued) {
            return NextResponse.json({
              ndaId: existingNda.id,
              invitePath: reissued.invitePath,
              inviteUrl: `${absoluteBase(req)}${reissued.invitePath}`,
              contentHash: existingNda.contentHash ?? "",
              reissued: true,
              simulated: true,
            });
          }
        }
        return NextResponse.json(
          { error: "nda_already_sent", ndaId: existingNda?.id ?? null },
          { status: 409 }
        );
      }
      try {
        assertCandidateTransition(
          demoCandidate.status as Parameters<typeof assertCandidateTransition>[0],
          "nda_sent"
        );
      } catch (e) {
        if (e instanceof CandidateTransitionError) {
          return NextResponse.json(
            { error: "invalid_candidate_state", detail: e.message },
            { status: 409 }
          );
        }
        throw e;
      }
      const created = createDemoNda(candidateId, projectId);
      if (!created) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      await writeAuditLog({
        entityType: "nda",
        entityId: created.ndaId,
        event: "NDA_SENT",
        actor: ndaActor,
        payload: { candidateId, projectId },
      });
      const demoNda = t.ndas.find((n) => n.id === created.ndaId);
      return NextResponse.json({
        ndaId: created.ndaId,
        invitePath: created.invitePath,
        inviteUrl: `${absoluteBase(req)}${created.invitePath}`,
        contentHash: demoNda?.contentHash ?? "",
        simulated: true,
      });
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

    if (!candidate || !project || candidate.projectId !== project.id) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId &&
        project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Idempotency: if the candidate already has a sent NDA, rotate the single-use
    // invite token and return the usable link so the operator is never stuck
    // without an invitation link.
    if (candidate.status === "nda_sent") {
      const [existing] = await db
        .select()
        .from(ndas)
        .where(eq(ndas.candidateId, candidateId))
        .limit(1);
      if (existing && existing.status === "sent") {
        const rawToken = generateInviteToken();
        const tokenHash = hashInviteToken(rawToken);
        const tokenExpiry = tokenExpiresAt();
        await db
          .update(ndas)
          .set({
            inviteTokenHash: tokenHash,
            inviteTokenUsed: false,
            inviteTokenRateLimit: 0,
            inviteTokenExpiresAt: tokenExpiry,
          })
          .where(eq(ndas.id, existing.id));
        const invitePath = `/invite/${existing.id}:${rawToken}`;
        const inviteUrl = `${absoluteBase(req)}${invitePath}`;
        await writeAuditLog({
          entityType: "nda",
          entityId: existing.id,
          event: "NDA_INVITE_REISSUED",
          actor: ndaActor,
          payload: { candidateId, projectId },
        });
        return NextResponse.json({
          ndaId: existing.id,
          invitePath,
          inviteUrl,
          contentHash: existing.contentHash ?? existing.documentHash ?? "",
          reissued: true,
        });
      }
      return NextResponse.json(
        { error: "nda_already_sent", ndaId: existing?.id ?? null },
        { status: 409 }
      );
    }

    // Candidate must be in a state that can receive an NDA.
    try {
      assertCandidateTransition(
        candidate.status as Parameters<typeof assertCandidateTransition>[0],
        "nda_sent"
      );
    } catch (e) {
      if (e instanceof CandidateTransitionError) {
        return NextResponse.json(
          { error: "invalid_candidate_state", detail: e.message },
          { status: 409 }
        );
      }
      throw e;
    }

    // Real company name for the NDA parties block.
    const [company] = project.companyId
      ? await db
          .select()
          .from(companies)
          .where(eq(companies.id, project.companyId))
          .limit(1)
      : [];

    // Generate NDA PDF
    const { pdfBytes, documentHash } = await generateNdaPdf({
      projectTitle: project.title,
      companyName: company?.name ?? "Demo Company",
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

    await db
      .update(candidates)
      .set({ status: "nda_sent", updatedAt: new Date() })
      .where(eq(candidates.id, candidateId));

    // Invite format "ndaId:rawToken" — matches /api/nda/accept validation.
    const invitePath = `/invite/${ndaId}:${rawToken}`;
    const inviteUrl = `${absoluteBase(req)}${invitePath}`;

    // Audit log — WITHOUT any token material.
    await writeAuditLog({
      entityType: "nda",
      entityId: ndaId,
      event: "NDA_SENT",
      actor: ndaActor,
      payload: {
        candidateId,
        projectId,
        expiresAt: ndaExpiry.toISOString(),
        tokenExpiresAt: tokenExpiry.toISOString(),
      },
    });

    return NextResponse.json({
      ndaId,
      invitePath,
      inviteUrl,
      contentHash: documentHash,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Failed to generate NDA";
    return NextResponse.json(
      { error: "nda_generation_failed", detail },
      { status: 500 }
    );
  }
}
