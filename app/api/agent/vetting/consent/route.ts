/**
 * PUT /api/agent/vetting/consent
 * Records candidate consent for vetting.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { candidates } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { isDemoMode } from "@/lib/demo/config";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";

export async function PUT(request: NextRequest) {
  const role = await getRoleFromCookie(request.headers.get("cookie"));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: recording vetting consent requires the company or admin role." },
      { status: 403 }
    );
  }
  let body: { candidateId?: string; projectId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { candidateId, projectId } = body;
  if (!candidateId || !projectId) {
    return NextResponse.json(
      { error: "candidateId and projectId are required" },
      { status: 400 }
    );
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const candidate = getDemoTables().candidates.find(
      (c) => c.id === candidateId && c.projectId === projectId
    );
    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }
    candidate.vettingConsentAt = new Date();
    candidate.updatedAt = new Date();
    return NextResponse.json({
      ok: true,
      consentAt: candidate.vettingConsentAt.toISOString(),
      simulated: true,
    });
  }

  const [candidate] = await db
    .select()
    .from(candidates)
    .where(
      and(eq(candidates.id, candidateId), eq(candidates.projectId, projectId))
    );

  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  await db
    .update(candidates)
    .set({ vettingConsentAt: new Date(), updatedAt: new Date() })
    .where(eq(candidates.id, candidateId));

  return NextResponse.json({ ok: true, consentAt: new Date().toISOString() });
}
