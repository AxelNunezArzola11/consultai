/**
 * POST /api/nda/regenerate
 *
 * Issues a fresh single-use invite link for an existing sent/pending NDA.
 * The previous token hash is replaced (old links stop working) and the raw
 * token is returned ONLY in this response — never stored, never logged.
 *
 * Body: { ndaId: string }
 * Returns: { ndaId, invitePath, inviteUrl, tokenExpiresAt }
 *
 * Server-side authorization: company or admin role only.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { ndas, projects } from "@/lib/db/schema";
import {
  generateInviteToken,
  hashInviteToken,
  tokenExpiresAt,
} from "@/lib/nda/invite-token";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { getBaseUrl } from "@/lib/constants/routes";
import { writeAuditLog } from "@/lib/db/audit";
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
      { error: "Forbidden: issuing invite links requires the company or admin role." },
      { status: 403 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("nda-regenerate", ip, 20, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: { ndaId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.ndaId || typeof body.ndaId !== "string" || body.ndaId.length > 100) {
    return NextResponse.json({ error: "ndaId is required" }, { status: 400 });
  }
  const reissueActor = session ? `${session.role}:${session.userId}` : `${role}-operator`;

  if (isDemoMode()) {
    const { issueDemoInvite, getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const demoNda = t.ndas.find((n) => n.id === body.ndaId);
    if (!demoNda) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId) {
      const demoProject = t.projects.find((p) => p.id === demoNda.projectId);
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    if (demoNda.status !== "sent" && demoNda.status !== "pending") {
      return NextResponse.json(
        { error: `cannot_reissue_for_status_${demoNda.status}` },
        { status: 409 }
      );
    }
    const invite = issueDemoInvite(demoNda.id);
    if (!invite) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await writeAuditLog({
      entityType: "nda",
      entityId: demoNda.id,
      event: "NDA_INVITE_REISSUED",
      actor: reissueActor,
      payload: {
        candidateId: demoNda.candidateId,
        projectId: demoNda.projectId,
        tokenExpiresAt: invite.tokenExpiresAt.toISOString(),
      },
    });
    return NextResponse.json({
      ndaId: invite.ndaId,
      invitePath: invite.invitePath,
      inviteUrl: `${absoluteBase(req)}${invite.invitePath}`,
      tokenExpiresAt: invite.tokenExpiresAt.toISOString(),
      simulated: true,
    });
  }

  const [nda] = await db
    .select()
    .from(ndas)
    .where(eq(ndas.id, body.ndaId))
    .limit(1);
  if (!nda) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (session?.role === "company" && session.companyId) {
    const [ndaProject] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, nda.projectId))
      .limit(1);
    if (!ndaProject || ndaProject.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }
  if (nda.status !== "sent" && nda.status !== "pending") {
    return NextResponse.json(
      { error: `cannot_reissue_for_status_${nda.status}` },
      { status: 409 }
    );
  }

  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const tokenExpiry = tokenExpiresAt();

  await db
    .update(ndas)
    .set({
      inviteToken: null,
      inviteTokenHash: tokenHash,
      inviteTokenUsed: false,
      inviteTokenRateLimit: 0,
      inviteTokenExpiresAt: tokenExpiry,
    })
    .where(eq(ndas.id, nda.id));

  const invitePath = `/invite/${nda.id}:${rawToken}`;

  // Audit WITHOUT any token material.
  await writeAuditLog({
    entityType: "nda",
    entityId: nda.id,
    event: "NDA_INVITE_REISSUED",
    actor: reissueActor,
    payload: {
      candidateId: nda.candidateId,
      projectId: nda.projectId,
      tokenExpiresAt: tokenExpiry.toISOString(),
    },
  });

  return NextResponse.json({
    ndaId: nda.id,
    invitePath,
    inviteUrl: `${absoluteBase(req)}${invitePath}`,
    tokenExpiresAt: tokenExpiry.toISOString(),
  });
}
