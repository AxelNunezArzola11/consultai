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

import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, milestones } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import {
  paymentChatTools,
  buildPaymentChatSystemPrompt,
} from "@/lib/payments/payment-chat-tools";

export const runtime = "nodejs";
// maxDuration is a hint to Vercel — actual cap depends on plan:
//   Hobby: 10s (hard cap, cannot be raised)
//   Pro:   up to 60s (enforced by vercel.json functions.maxDuration)
// This value is also set in vercel.json for explicit declaration.
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
  // ── Diagnostic: confirm env vars are visible in this serverless instance ──
  console.log("[payment-chat] env check:", {
    DATABASE_URL: !!process.env.DATABASE_URL,
    GROQ_API_KEY: !!process.env.GROQ_API_KEY,
    ROLE_COOKIE_SECRET: !!process.env.ROLE_COOKIE_SECRET,
    LLM_GROQ_MODEL: process.env.LLM_GROQ_MODEL ?? "(default: qwen/qwen3-32b)",
  });

  try {
    return await paymentChatHandler(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause
      ? String((err.cause as Error).message ?? err.cause)
      : undefined;
    console.error("[payment-chat] unhandled top-level error:", { message, cause });
    return Response.json(
      { error: "Internal server error", detail: message, cause },
      { status: 500 }
    );
  }
}

async function paymentChatHandler(req: NextRequest) {
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

  // Validate project exists + load milestones in parallel.
  // We fetch milestones here (not only via tool) so the system prompt contains
  // ground-truth context from turn 1. Without this the AI hallucinates "no milestones"
  // because it hasn't called listMilestones yet and the system prompt is empty.
  const [projectRows, milestoneRows] = await Promise.all([
    db
      .select({ id: projects.id, title: projects.title })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
    db
      .select({
        id: milestones.id,
        title: milestones.title,
        status: milestones.status,
        budgetUsd: milestones.budgetUsd,
        dueDate: milestones.dueDate,
        position: milestones.position,
      })
      .from(milestones)
      .where(eq(milestones.projectId, projectId))
      .orderBy(milestones.position),
  ]);

  if (projectRows.length === 0) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const safeMessages = Array.isArray(messages) ? messages : [];

  // Convert UI-format messages (parts schema) → ModelMessage[] (content schema)
  // useChat sends { role, parts: [{type,text},...] }; streamText requires { role, content }
  const modelMessages = safeMessages.length > 0
    ? await convertToModelMessages(
        safeMessages as Parameters<typeof convertToModelMessages>[0]
      )
    : [];

  // Graceful fallback when GROQ_API_KEY is not set
  let llm;
  try {
    llm = getLLM();
  } catch (err) {
    console.error("[payment-chat] getLLM failed:", err);
    return Response.json({ error: classifyLLMError(err) }, { status: 503 });
  }

  // Build system prompt with pre-loaded milestone context so the AI knows
  // what milestones exist from the very first turn without needing a tool call.
  const systemPrompt = buildPaymentChatSystemPrompt(projectId, milestoneRows);

  console.log("[payment-chat] milestones loaded:", milestoneRows.length, "for project", projectId);

  let result;
  const streamArgs = modelMessages.length > 0
    ? {
        model: llm,
        system: systemPrompt,
        messages: modelMessages,
        tools: paymentChatTools,
        stopWhen: stepCountIs(8),
        onError: (error: { message?: string; error?: unknown }) => {
          console.error("[payment-chat] streamText error:", error);
        },
      }
    : {
        model: llm,
        system: systemPrompt,
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
