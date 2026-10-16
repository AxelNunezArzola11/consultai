/**
 * POST /api/agent/brief
 *
 * BriefAgent streaming endpoint.
 * Uses Vercel AI SDK streamText with tool calling.
 *
 * Body:
 *   {
 *     messages: UIMessage[]     — chat history (useChat format)
 *     projectId: string          — project to save plan to
 *     agentSessionId: string     — ephemeral session key for rate limiting + draft saving
 *     rawBrief?: string          — initial brief text (first call only)
 *   }
 *
 * Rate limit: BRIEF_LIMITS.SESSION_RATE_LIMIT per session per hour.
 * Returns: Vercel AI SDK text stream (pipeDataStreamToResponse format).
 *
 * Security:
 *   - Raw brief is delimited before insertion into the prompt (injection hardening).
 *   - Tool list is static; user input cannot extend it.
 *   - projectId is validated against DB (must exist) before use.
 *   - agentSessionId is validated as alphanumeric-safe (nanoid format).
 */

import { streamText, stepCountIs } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { checkBriefRateLimit } from "@/lib/brief/rate-limit";
import {
  briefAgentTools,
  buildBriefAgentSystemPrompt,
  wrapUserBrief,
} from "@/lib/brief/tools";
import { BRIEF_LIMITS } from "@/lib/brief/schema";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby: max 300s; 60s is plenty for brief gen

// ---------------------------------------------------------------------------
// LLM provider
// ---------------------------------------------------------------------------

function getLLM() {
  const provider = process.env.LLM_PROVIDER ?? "groq";
  if (provider === "groq") {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY environment variable is not set.");
    }
    const groq = createGroq({ apiKey });
    const model = process.env.LLM_GROQ_MODEL ?? "qwen/qwen3-32b";
    return groq(model);
  }
  throw new Error(`LLM_PROVIDER "${provider}" not supported. Use "groq".`);
}

// ── Classify a Groq / AI SDK error into a user-readable message ──────────────
function classifyLLMError(err: unknown): string {
  if (!(err instanceof Error)) return "AI service error";
  const msg = err.message;
  if (msg.includes("GROQ_API_KEY") || msg.includes("not set")) {
    return "AI service is not configured. Set GROQ_API_KEY to enable the chat assistant.";
  }
  if (msg.includes("rate limit") || msg.includes("429") || msg.includes("Rate limit")) {
    return "Groq rate limit reached. Please wait a moment and try again.";
  }
  if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("invalid_api_key")) {
    return "Invalid Groq API key. Check the GROQ_API_KEY environment variable.";
  }
  if (msg.includes("503") || msg.includes("overloaded") || msg.includes("unavailable")) {
    return "The AI service is temporarily unavailable. Please retry in a few seconds.";
  }
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("network")) {
    return "Connection to the AI service timed out. Please retry.";
  }
  return `AI service error: ${msg.slice(0, 200)}`;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let body: {
    messages?: unknown[];
    projectId?: string;
    agentSessionId?: string;
    rawBrief?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, projectId, agentSessionId, rawBrief } = body;

  // --- Input validation ---

  if (!projectId || typeof projectId !== "string" || projectId.length > 100) {
    return Response.json({ error: "projectId required" }, { status: 400 });
  }

  if (
    !agentSessionId ||
    typeof agentSessionId !== "string" ||
    agentSessionId.length > 100 ||
    !/^[a-zA-Z0-9_-]+$/.test(agentSessionId)
  ) {
    return Response.json({ error: "agentSessionId required (alphanumeric)" }, { status: 400 });
  }

  // Brief length cap — reject, don't truncate on server (client should cap too)
  if (rawBrief && rawBrief.length > BRIEF_LIMITS.INPUT_MAX_CHARS) {
    return Response.json(
      {
        error: `Brief exceeds maximum length of ${BRIEF_LIMITS.INPUT_MAX_CHARS} characters`,
      },
      { status: 400 }
    );
  }

  // Validate project exists
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (projectRows.length === 0) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // --- Rate limit ---
  const rateResult = await checkBriefRateLimit(agentSessionId);
  if (!rateResult.allowed) {
    return Response.json(
      {
        error: "Rate limit exceeded. Please wait before sending more messages.",
        retryAfterMs: rateResult.retryAfterMs,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((rateResult.retryAfterMs ?? 3600000) / 1000)),
        },
      }
    );
  }

  // --- Build messages array ---
  // The first user message wraps the raw brief in XML delimiters for injection safety.
  // Subsequent messages are passed through unchanged.
  const safeMessages = Array.isArray(messages) ? messages : [];

  // If rawBrief is provided and this is the first turn, replace the last user
  // message's text with the delimited version.
  const processedMessages = safeMessages.map((msg: unknown) => {
    const m = msg as Record<string, unknown>;
    if (m.role === "user" && rawBrief) {
      // Only wrap on the first user message (the brief itself)
      const parts = Array.isArray(m.parts) ? m.parts : [];
      const hasDelimited = parts.some(
        (p: unknown) =>
          typeof p === "object" &&
          p !== null &&
          (p as { type?: string }).type === "text" &&
          typeof (p as { text?: string }).text === "string" &&
          (p as { text?: string }).text!.includes("<user_brief>")
      );
      if (!hasDelimited && parts.length > 0) {
        return {
          ...m,
          parts: parts.map((p: unknown, i: number) => {
            if (
              i === 0 &&
              typeof p === "object" &&
              p !== null &&
              (p as { type?: string }).type === "text"
            ) {
              return { ...(p as object), text: wrapUserBrief(rawBrief) };
            }
            return p;
          }),
        };
      }
    }
    return msg;
  });

  // --- Stream ---
  let llm;
  try {
    llm = getLLM();
  } catch (err) {
    console.error("[brief-agent] getLLM failed:", err);
    return Response.json({ error: classifyLLMError(err) }, { status: 503 });
  }

  // streamText requires either `messages` (non-empty) or `prompt`.
  // When there are no prior messages, use the brief as prompt.
  const streamArgs = processedMessages.length > 0
    ? {
        model: llm,
        system: buildBriefAgentSystemPrompt(projectId, agentSessionId),
        messages: processedMessages as Parameters<typeof streamText>[0]["messages"],
        tools: briefAgentTools,
        stopWhen: stepCountIs(10),
        onError: (error: { message?: string; error?: unknown }) => {
          console.error("[brief-agent] streamText error:", error);
        },
      }
    : {
        model: llm,
        system: buildBriefAgentSystemPrompt(projectId, agentSessionId),
        prompt: rawBrief
          ? wrapUserBrief(rawBrief)
          : "Please ask me what I want to build.",
        tools: briefAgentTools,
        stopWhen: stepCountIs(10),
        onError: (error: { message?: string; error?: unknown }) => {
          console.error("[brief-agent] streamText error:", error);
        },
      };

  let result;
  try {
    result = streamText(streamArgs as Parameters<typeof streamText>[0]);
  } catch (err) {
    console.error("[brief-agent] streamText threw synchronously:", err);
    return Response.json({ error: classifyLLMError(err) }, { status: 503 });
  }

  return result.toUIMessageStreamResponse();
}
