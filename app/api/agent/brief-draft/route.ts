/**
 * POST /api/agent/brief-draft
 *
 * Saves or updates a brief draft (plan JSON + brief text) for a session.
 * Called on every plan update from the client (debounced 1s).
 *
 * Body: { projectId, agentSessionId, plan }
 */

import { db } from "@/lib/db";
import { briefDrafts } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    agentSessionId?: string;
    plan?: unknown;
    briefText?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { projectId, agentSessionId, plan, briefText } = body;

  if (
    !agentSessionId ||
    typeof agentSessionId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(agentSessionId) ||
    agentSessionId.length > 100
  ) {
    return Response.json({ error: "agentSessionId required" }, { status: 400 });
  }

  // Upsert: update existing draft for this session, or insert new
  const existing = await db
    .select({ id: briefDrafts.id })
    .from(briefDrafts)
    .where(eq(briefDrafts.agentSessionId, agentSessionId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(briefDrafts)
      .set({
        planJson: plan as Record<string, unknown> ?? null,
        briefText: briefText ?? null,
        updatedAt: new Date(),
      })
      .where(eq(briefDrafts.agentSessionId, agentSessionId));
  } else {
    await db.insert(briefDrafts).values({
      id: nanoid(),
      projectId: projectId ?? null,
      agentSessionId,
      planJson: plan as Record<string, unknown> ?? null,
      briefText: briefText ?? null,
    });
  }

  return Response.json({ ok: true });
}
