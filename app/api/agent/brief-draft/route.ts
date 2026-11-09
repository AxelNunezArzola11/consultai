/**
 * POST /api/agent/brief-draft
 *
 * Saves or updates a brief draft (plan JSON + brief text) for a session.
 * Called on every plan update from the client (debounced 1s).
 *
 * Body: { projectId, agentSessionId, plan }
 *
 * Demo clients also send projectTitle (creation title) so a cold serverless
 * instance can rehydrate the draft instead of rejecting the save.
 */

import { db } from "@/lib/db";
import { briefDrafts, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo/config";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { creatorScopedKey } from "@/lib/brief/creator-scope";

export async function POST(req: NextRequest) {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Live mode: drafts are creator-bound writes, so a verified session is
  // required — session-less role holders cannot write to any project.
  // Demo mode keeps the simulated write for the role-switcher walkthrough.
  if (!isDemoMode() && !session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("brief-draft", ip, 60, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: {
    projectId?: string;
    agentSessionId?: string;
    plan?: unknown;
    briefText?: string;
    projectTitle?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { projectId, agentSessionId, plan, briefText, projectTitle } = body;

  if (!projectId || typeof projectId !== "string" || projectId.length > 100) {
    return Response.json({ error: "projectId required" }, { status: 400 });
  }

  if (
    !agentSessionId ||
    typeof agentSessionId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(agentSessionId) ||
    agentSessionId.length > 100
  ) {
    return Response.json({ error: "agentSessionId required" }, { status: 400 });
  }

  if (briefText !== undefined && (typeof briefText !== "string" || briefText.length > 100000)) {
    return Response.json({ error: "briefText too large" }, { status: 400 });
  }

  // Demo mode: drafts live only in the planner UI session (no persistence
  // needed — Approve & Save persists the plan to the demo store instead).
  if (isDemoMode()) {
    if (session?.role === "company" && session.companyId) {
      const { getDemoTables } = await import("@/lib/demo/store");
      const {
        demoCompanyForSession,
        resolveDemoDraftForPlanning,
      } = await import("@/lib/demo/drafts");
      const found = getDemoTables().projects.find((p) => p.id === projectId);
      // Serverless-safe: a cold instance rehydrates the POST-accepted draft
      // from the creation title; bare IDs still 403 honestly.
      const demoProject =
        found ??
        resolveDemoDraftForPlanning({
          projectId,
          title: projectTitle,
          companyId: demoCompanyForSession(session.companyId),
        });
      if (!demoProject || demoProject.companyId !== session.companyId) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
    }
    return Response.json({ ok: true, id: agentSessionId, simulated: true });
  }

  // Live-only from here: the gate above guarantees a verified session.
  const liveSession = session;
  if (!liveSession) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const [project] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  // Company callers are always ownership-checked (no session-company bypass).
  if (
    liveSession.role === "company" &&
    project.companyId !== liveSession.companyId
  ) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Upsert scoped by (creator + agentSessionId + projectId): the stored key
  // is namespaced by the authenticated creator, so a same-company caller
  // replaying another user's client-supplied id writes a different row
  // instead of overwriting their draft.
  const storedSessionId = creatorScopedKey(liveSession.userId, agentSessionId);
  const scope = and(
    eq(briefDrafts.agentSessionId, storedSessionId),
    eq(briefDrafts.projectId, projectId)
  );
  const existing = await db
    .select({ id: briefDrafts.id })
    .from(briefDrafts)
    .where(scope)
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(briefDrafts)
      .set({
        planJson: plan as Record<string, unknown> ?? null,
        briefText: briefText ?? null,
        updatedAt: new Date(),
      })
      .where(scope);
  } else {
    await db.insert(briefDrafts).values({
      id: nanoid(),
      projectId,
      agentSessionId: storedSessionId,
      planJson: plan as Record<string, unknown> ?? null,
      briefText: briefText ?? null,
    });
  }

  return Response.json({ ok: true });
}
