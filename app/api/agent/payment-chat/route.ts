/**
 * POST /api/agent/payment-chat
 *
 * Payment Chat Agent streaming endpoint.
 * Enables the company to negotiate, query, and trigger milestone payments
 * through a conversational interface.
 *
 * Auth: requires company role cookie.
 * Body: { messages, projectId }
 * Returns: Vercel AI SDK UI message stream.
 *
 * Design invariants:
 * - No actual PayPal API calls made here — tools only read/prepare
 * - requestPayoutApproval tool returns action payload; UI executes the real payout
 * - LLM cannot change policy — threshold enforcement is in the payout route
 * - Tool allowlist is static; user input cannot extend it
 */

import { streamText, stepCountIs } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import {
  paymentChatTools,
  buildPaymentChatSystemPrompt,
} from "@/lib/payments/payment-chat-tools";

export const runtime = "nodejs";
export const maxDuration = 60;

// ── LLM provider ───────────────────────────────────────────────────────────

function getLLM() {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    throw new Error("GROQ_API_KEY environment variable is not set.");
  }
  const groq = createGroq({ apiKey: groqApiKey });
  const model = process.env.LLM_GROQ_MODEL ?? "qwen/qwen3-32b";
  return groq(model);
}

function classifyLLMError(err: unknown): string {
  if (!(err instanceof Error)) return "AI service error";
  const msg = err.message;
  if (msg.includes("GROQ_API_KEY") || msg.includes("not set")) {
    return "AI service is not configured. Set GROQ_API_KEY to enable the payment chat.";
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

// ── POST handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth — company only
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { messages?: unknown[]; projectId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, projectId } = body;

  if (!projectId || typeof projectId !== "string" || projectId.length > 100) {
    return Response.json({ error: "projectId required" }, { status: 400 });
  }

  // Validate project exists
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const safeMessages = Array.isArray(messages) ? messages : [];

  // Graceful fallback when GROQ_API_KEY is not set
  let llm;
  try {
    llm = getLLM();
  } catch (err) {
    console.error("[payment-chat] getLLM failed:", err);
    return Response.json({ error: classifyLLMError(err) }, { status: 503 });
  }

  let result;
  const streamArgs = safeMessages.length > 0
    ? {
        model: llm,
        system: buildPaymentChatSystemPrompt(projectId),
        messages: safeMessages as Parameters<typeof streamText>[0]["messages"],
        tools: paymentChatTools,
        stopWhen: stepCountIs(8),
        onError: (error: { message?: string; error?: unknown }) => {
          console.error("[payment-chat] streamText error:", error);
        },
      }
    : {
        model: llm,
        system: buildPaymentChatSystemPrompt(projectId),
        prompt: "Hello, what can you help me with for payments?",
        tools: paymentChatTools,
        stopWhen: stepCountIs(8),
        onError: (error: { message?: string; error?: unknown }) => {
          console.error("[payment-chat] streamText error:", error);
        },
      };

  try {
    result = streamText(streamArgs as Parameters<typeof streamText>[0]);
  } catch (err) {
    console.error("[payment-chat] streamText threw synchronously:", err);
    return Response.json({ error: classifyLLMError(err) }, { status: 503 });
  }

  return result.toUIMessageStreamResponse();
}
