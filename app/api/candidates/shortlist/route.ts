/**
 * POST /api/candidates/shortlist
 *
 * Shortlists a candidate — sets status to "shortlisted" and feeds the Phase 4 pipeline.
 * Requires company role cookie.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { candidates } from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { eq, and } from "drizzle-orm";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";

export async function POST(request: NextRequest) {
  const role = await getRoleFromCookie(request.headers.get("cookie"));
  if (role !== "company") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { candidateId?: string; projectId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { candidateId, projectId } = body;
  if (!candidateId || !projectId) {
    return NextResponse.json({ error: "candidateId and projectId are required" }, { status: 400 });
  }

  const [candidate] = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.id, candidateId), eq(candidates.projectId, projectId)));

  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  // Idempotent — already shortlisted is fine
  if (candidate.status === "shortlisted") {
    return NextResponse.json({ ok: true, status: "shortlisted", alreadyShortlisted: true });
  }

  await db
    .update(candidates)
    .set({ status: "shortlisted", updatedAt: new Date() })
    .where(eq(candidates.id, candidateId));

  await writeAuditLog({
    entityType: "candidate",
    entityId: candidateId,
    event: "CANDIDATE_SHORTLISTED",
    actor: "company",
    payload: { projectId, previousStatus: candidate.status },
  });

  return NextResponse.json({ ok: true, status: "shortlisted" });
}
