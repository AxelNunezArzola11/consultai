/**
 * GET /api/sse/ai-ops
 *
 * Server-Sent Events (SSE) endpoint streaming real-time AI Operations Center telemetry:
 * - Agent availability & active workflow counts
 * - Latest multi-agent executions
 * - Pending human approvals (financial & scheduling proposals)
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getAiOpsDashboardSnapshot } from "@/lib/ai-ops/orchestrator-engine";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode, DEMO_IDS } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

// Per-IP concurrent stream cap (best-effort, per-process).
const activeStreamsByIp = new Map<string, number>();
const MAX_CONCURRENT_STREAMS_PER_IP = 3;

export async function GET(req: NextRequest): Promise<Response> {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("sse-ai-ops", ip, 10, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }
  const active = activeStreamsByIp.get(ip) ?? 0;
  if (active >= MAX_CONCURRENT_STREAMS_PER_IP) {
    return NextResponse.json(
      { error: "Too many concurrent streams" },
      { status: 429 }
    );
  }

  // Company scope comes only from the verified session (same contract as
  // GET /api/ai-ops/executions). The scope is resolved BEFORE the stream
  // opens so rejected callers never receive an event.
  const scopeCompanyId =
    role === "admin"
      ? null
      : session?.role === "company" && session.companyId
        ? session.companyId
        : isDemoMode()
          ? DEMO_IDS.company
          : null;
  if (role === "company" && scopeCompanyId == null) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId") ?? undefined;
  if (projectId && role === "company" && scopeCompanyId != null) {
    let ownerCompanyId: string | null | undefined;
    if (isDemoMode()) {
      const { getDemoTables } = await import("@/lib/demo/store");
      ownerCompanyId = getDemoTables().projects.find(
        (p) => p.id === projectId
      )?.companyId;
    } else {
      const [project] = await db
        .select({ companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      ownerCompanyId = project?.companyId;
    }
    if (!ownerCompanyId || ownerCompanyId !== scopeCompanyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  activeStreamsByIp.set(ip, active + 1);
  const releaseStream = () => {
    const current = activeStreamsByIp.get(ip) ?? 1;
    if (current <= 1) activeStreamsByIp.delete(ip);
    else activeStreamsByIp.set(ip, current - 1);
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Stream closed by client
        }
      };

      try {
        const initialSnapshot = await getAiOpsDashboardSnapshot({
          projectId,
          scopeCompanyId,
          role,
        });
        sendEvent("snapshot", {
          timestamp: new Date().toISOString(),
          ...initialSnapshot,
        });
      } catch (err) {
        sendEvent("error", {
          message: err instanceof Error ? err.message : "Failed to load initial AI Ops snapshot",
        });
      }

      // Session-bound streams re-authenticate on every tick: a revoked or
      // expired session (or lost role) terminates the stream instead of
      // leaking further snapshots. Scope is enforced per event, not just
      // at open. Role-cookie streams (demo/admin-global) re-resolve the
      // role the same way so expiry closes them too.
      const sessionBound = session != null;
      const interval = setInterval(async () => {
        try {
          const liveSession = sessionBound
            ? await getSessionFromCookie(cookieHeader)
            : null;
          const liveRole =
            liveSession?.role ?? (await getRoleFromCookie(cookieHeader));
          if (!liveRole || (sessionBound && !liveSession)) {
            sendEvent("error", { message: "session_expired" });
            clearInterval(interval);
            releaseStream();
            try {
              controller.close();
            } catch {
              // Already closed
            }
            return;
          }
          const updated = await getAiOpsDashboardSnapshot({
            projectId,
            scopeCompanyId,
            role,
          });
          sendEvent("snapshot", {
            timestamp: new Date().toISOString(),
            ...updated,
          });
        } catch {
          sendEvent("heartbeat", { timestamp: new Date().toISOString() });
        }
      }, 6000);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        releaseStream();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
