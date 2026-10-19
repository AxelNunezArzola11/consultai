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

export async function PUT(request: NextRequest) {
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
