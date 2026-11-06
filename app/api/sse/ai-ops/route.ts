/**
 * GET /api/sse/ai-ops
 *
 * Server-Sent Events (SSE) endpoint streaming real-time AI Operations Center telemetry:
 * - Agent availability & active workflow counts
 * - Latest multi-agent executions
 * - Pending human approvals (financial & scheduling proposals)
 */

import { NextRequest } from "next/server";
import { getAiOpsDashboardSnapshot } from "@/lib/ai-ops/orchestrator-engine";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId") ?? undefined;

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
        const initialSnapshot = await getAiOpsDashboardSnapshot(projectId);
        sendEvent("snapshot", {
          timestamp: new Date().toISOString(),
          ...initialSnapshot,
        });
      } catch (err) {
        sendEvent("error", {
          message: err instanceof Error ? err.message : "Failed to load initial AI Ops snapshot",
        });
      }

      const interval = setInterval(async () => {
        try {
          const updated = await getAiOpsDashboardSnapshot(projectId);
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
