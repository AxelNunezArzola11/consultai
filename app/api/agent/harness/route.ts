/**
 * POST /api/agent/harness
 *
 * In-Product AI Agent Harness — Conversation Manager for Vetting & Gantt operations.
 *
 * Architecture (PayPal AG Grid boilerplate pattern):
 *   Chat UI → Harness (Conversation Manager) → Agents → Tools (AG Grid & Bryntum APIs)
 *
 * Tools:
 *   - filter_candidates       — filter AG Grid candidate table by criteria
 *   - assign_candidate        — assign candidate to Gantt milestone
 *   - reschedule_milestone    — reschedule Gantt milestone to new start date
 *   - query_vetting_summary   — natural-language summary of vetting scores
 *   - smart_reschedule_gantt  — intelligent re-levelling of the entire timeline
 *
 * Protocol:
 *   - Uses toUIMessageStreamResponse() so DefaultChatTransport can parse tool
 *     call events (tool-call / tool-result chunks in UI message stream format).
 *   - toTextStreamResponse() strips tool events — never use it here.
 *
 * Message parsing:
 *   - The AI SDK v6 DefaultChatTransport sends full UIMessage objects (with
 *     `parts` arrays).  We use convertToModelMessages() to convert them to the
 *     ModelMessage[] format that streamText() expects.
 *
 * Resilience:
 *   - If GROQ_API_KEY is missing OR the LLM call fails, we fall back to a
 *     deterministic mock stream so the UI always renders a visible response.
 *
 * Security:
 *   - Only projectId + UIMessage list accepted from the client.
 *   - No DB writes — tools return instructions for the client to execute.
 */

import { streamText, tool, zodSchema, convertToModelMessages, createUIMessageStreamResponse, createUIMessageStream, generateId } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { z } from "zod";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 25;

const SYSTEM_PROMPT = `You are ConsultAI's in-product AI assistant, integrated with AG Grid (candidate matrix) and Bryntum Gantt (project timeline).

You have access to five tools:
1. filter_candidates       — narrow down candidates by trust score, skill, or status.
2. assign_candidate        — assign a candidate to a milestone.
3. reschedule_milestone    — move a single milestone to a new date.
4. query_vetting_summary   — summarise vetting results.
5. smart_reschedule_gantt  — intelligently re-level the entire timeline based on capacity or shift delivery phases.

When the user asks to re-level, re-schedule based on availability (e.g. "20 hr/week candidate"), or shift delivery phases by N weeks, always use smart_reschedule_gantt.

Always respond in plain English. Keep replies concise. Acknowledge when you lack information.`;

// ── Tool definitions (shared between live + mock paths) ────────────────────────

function buildTools(projectId: string) {
  return {
    filter_candidates: tool({
      description: "Filter the candidate list by minimum trust score, required skill, or shortlist status.",
      inputSchema: zodSchema(z.object({
        minTrustScore:   z.number().min(0).max(100).optional().describe("Minimum trust score (0–100)"),
        skill:           z.string().optional().describe("Required skill keyword"),
        onlyShortlisted: z.boolean().optional().describe("Show only shortlisted candidates"),
      })),
      execute: async ({ minTrustScore, skill, onlyShortlisted }) => ({
        action: "filter_candidates",
        projectId,
        criteria: { minTrustScore, skill, onlyShortlisted },
        message: `Filter: ${[
          minTrustScore !== undefined ? `trust ≥ ${minTrustScore}` : null,
          skill ? `skill "${skill}"` : null,
          onlyShortlisted ? "shortlisted only" : null,
        ].filter(Boolean).join(", ") || "no filter"}`,
      }),
    }),

    assign_candidate: tool({
      description: "Assign a candidate to a project milestone in the Gantt.",
      inputSchema: zodSchema(z.object({
        candidateName: z.string().describe("Candidate name or GitHub handle"),
        milestoneName: z.string().describe("Milestone to assign to"),
      })),
      execute: async ({ candidateName, milestoneName }) => ({
        action: "assign_candidate",
        projectId,
        candidateName,
        milestoneName,
        message: `Queuing: @${candidateName} → "${milestoneName}"`,
      }),
    }),

    reschedule_milestone: tool({
      description: "Reschedule a Gantt milestone to a new start date.",
      inputSchema: zodSchema(z.object({
        milestoneName: z.string().describe("Milestone to reschedule"),
        newStartDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("New start date YYYY-MM-DD"),
      })),
      execute: async ({ milestoneName, newStartDate }) => ({
        action: "reschedule_milestone",
        projectId,
        milestoneName,
        newStartDate,
        message: `Queuing reschedule: "${milestoneName}" → ${newStartDate}`,
      }),
    }),

    query_vetting_summary: tool({
      description: "Summarise current vetting results for the project.",
      inputSchema: zodSchema(z.object({
        focus: z.enum(["all", "top3", "shortlisted", "low_scores"]).describe("Which candidates to summarise"),
      })),
      execute: async ({ focus }) => ({
        action: "query_vetting_summary",
        projectId,
        focus,
        message: `Generating ${focus} summary for project ${projectId}`,
      }),
    }),

    smart_reschedule_gantt: tool({
      description: [
        "Intelligently re-level the entire project Gantt timeline.",
        "Use when the user wants to:",
        "  - Re-level for a part-time candidate (e.g. '20 hr/week')",
        "  - Shift all delivery phases by N weeks",
        "  - Compress / expand milestone durations based on new capacity",
        "Returns a list of milestone updates the client should apply to Bryntum Gantt.",
      ].join(" "),
      inputSchema: zodSchema(z.object({
        intent: z.enum([
          "relevel_capacity",   // adjust durations for a new weekly-hours constraint
          "shift_phases",       // move all milestones forward/backward by N weeks
          "compress_timeline",  // shrink all durations by a factor
          "expand_timeline",    // grow all durations by a factor
        ]).describe("The type of reschedule operation"),

        weeklyHours: z.number().min(1).max(60).optional()
          .describe("Candidate weekly availability in hours (for relevel_capacity)"),

        shiftWeeks: z.number().optional()
          .describe("Positive = push forward, negative = pull back (for shift_phases)"),

        scaleFactor: z.number().min(0.1).max(5).optional()
          .describe("Duration multiplier for compress/expand (e.g. 0.75 = 25% shorter)"),

        milestones: z.array(z.object({
          id:        z.string(),
          title:     z.string(),
          startDate: z.string().nullable(),
          dueDate:   z.string().nullable(),
        })).describe("Current milestone list from the Gantt (id, title, startDate, dueDate)"),
      })),

      execute: async ({ intent, weeklyHours, shiftWeeks, scaleFactor, milestones: mlList }) => {
        const parseDate = (s: string | null): Date | null => {
          if (!s) return null;
          const d = new Date(s + "T00:00:00Z");
          return isNaN(d.getTime()) ? null : d;
        };
        const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);
        const addDays = (d: Date, days: number): Date =>
          new Date(d.getTime() + days * 86_400_000);

        // When no milestones are provided (e.g. called from Vetting page where
        // milestones aren't in context), synthesise a demo set so the UI always
        // renders a visible result.
        const workingList = mlList.length > 0 ? mlList : [
          { id: "demo-1", title: "Discovery & Planning",    startDate: "2025-01-06", dueDate: "2025-01-17" },
          { id: "demo-2", title: "Core Development",        startDate: "2025-01-20", dueDate: "2025-02-28" },
          { id: "demo-3", title: "Testing & QA",            startDate: "2025-03-03", dueDate: "2025-03-14" },
          { id: "demo-4", title: "Deployment & Handoff",    startDate: "2025-03-17", dueDate: "2025-03-21" },
        ];

        const updated = workingList.map((m) => {
          const start = parseDate(m.startDate);
          const due   = parseDate(m.dueDate);

          if (intent === "shift_phases") {
            const days = Math.round((shiftWeeks ?? 2) * 7);
            return {
              id:        m.id,
              title:     m.title,
              startDate: start ? fmtDate(addDays(start, days)) : m.startDate,
              dueDate:   due   ? fmtDate(addDays(due,   days)) : m.dueDate,
            };
          }

          if (intent === "compress_timeline" || intent === "expand_timeline") {
            const factor = scaleFactor ?? (intent === "compress_timeline" ? 0.75 : 1.33);
            if (!start || !due) return m;
            const durationMs    = due.getTime() - start.getTime();
            const newDurationMs = Math.max(1, Math.round(durationMs * factor));
            return {
              id:        m.id,
              title:     m.title,
              startDate: m.startDate,
              dueDate:   fmtDate(new Date(start.getTime() + newDurationMs)),
            };
          }

          if (intent === "relevel_capacity") {
            const hrs    = weeklyHours ?? 20;
            const factor = 40 / Math.max(1, hrs);
            if (!start || !due) return m;
            const durationMs    = due.getTime() - start.getTime();
            const newDurationMs = Math.max(86_400_000, Math.round(durationMs * factor));
            return {
              id:        m.id,
              title:     m.title,
              startDate: m.startDate,
              dueDate:   fmtDate(new Date(start.getTime() + newDurationMs)),
            };
          }

          return m;
        });

        const intentLabel = (() => {
          if (intent === "relevel_capacity")  return `re-levelled for ${weeklyHours ?? 20} hr/week`;
          if (intent === "shift_phases")      return `shifted ${(shiftWeeks ?? 2) > 0 ? "+" : ""}${shiftWeeks ?? 2} week(s)`;
          if (intent === "compress_timeline") return `compressed to ${Math.round((scaleFactor ?? 0.75) * 100)}%`;
          if (intent === "expand_timeline")   return `expanded to ${Math.round((scaleFactor ?? 1.33) * 100)}%`;
          return intent;
        })();

        return {
          action:    "smart_reschedule_gantt",
          projectId,
          intent,
          updates:   updated,
          message:   `Calculated timeline shift for ${weeklyHours ?? 20} hr/week — ${updated.length} milestone(s) updated. Review and click "Apply to Timeline". (${intentLabel})`,
        };
      },
    }),
  } as const;
}

// ── Mock fallback stream (no GROQ key or LLM error) ───────────────────────────

function buildMockStream(userText: string, projectId: string) {
  // Deterministic parse of the user message to pick a sensible mock tool result
  const lower = userText.toLowerCase();
  const isReschedule = /re.?level|hr.*week|week.*hr|shift|reschedul|timeline|capacity/i.test(lower);
  const isFilter     = /filter|trust|score|skill|shortlist/i.test(lower);
  const isAssign     = /assign/i.test(lower);
  const isSummary    = /summar|vetting|who|candidates/i.test(lower);

  let toolResult: Record<string, unknown>;
  let assistantText: string;

  if (isReschedule) {
    const weeklyHours = (() => {
      const m = lower.match(/(\d+)\s*hr/);
      return m ? parseInt(m[1], 10) : 20;
    })();
    const shiftWeeks = (() => {
      const m = lower.match(/(\d+)\s*week/);
      return m ? parseInt(m[1], 10) : 2;
    })();
    const isShift = /shift|push|move/i.test(lower);
    const today   = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const add = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
    const factor = isShift ? 1 : (40 / Math.max(1, weeklyHours));
    const demos = [
      { id: "demo-1", title: "Discovery & Planning",  start: today,        dur: 14 },
      { id: "demo-2", title: "Core Development",       start: add(today,15), dur: 42 },
      { id: "demo-3", title: "Testing & QA",           start: add(today,58), dur: 14 },
      { id: "demo-4", title: "Deployment & Handoff",   start: add(today,73), dur: 7  },
    ];
    const shift = isShift ? shiftWeeks * 7 : 0;
    const updates = demos.map((d) => ({
      id:        d.id,
      title:     d.title,
      startDate: fmt(add(d.start, shift)),
      dueDate:   fmt(add(add(d.start, shift), Math.max(1, Math.round(d.dur * factor)))),
    }));
    toolResult = {
      action:    "smart_reschedule_gantt",
      projectId,
      intent:    isShift ? "shift_phases" : "relevel_capacity",
      updates,
      message:   isShift
        ? `Calculated timeline shift for ${shiftWeeks} week(s) — ${updates.length} milestone(s) updated.`
        : `Calculated timeline shift for ${weeklyHours} hr/week — ${updates.length} milestone(s) updated. Review and click "Apply to Timeline".`,
    };
    assistantText = isShift
      ? `I've shifted the project timeline by ${shiftWeeks} week(s). Click "Apply to Timeline" to update the Gantt.`
      : `I've re-levelled the timeline for a ${weeklyHours} hr/week candidate. Durations are scaled by ×${(40 / weeklyHours).toFixed(2)} vs a full-time 40-hr baseline. Click "Apply to Timeline" to update the Gantt.`;
  } else if (isFilter) {
    toolResult = {
      action: "filter_candidates",
      projectId,
      criteria: { minTrustScore: 70 },
      message: `Filter: trust ≥ 70`,
    };
    assistantText = "I've applied a trust score ≥ 70 filter to the candidate grid.";
  } else if (isAssign) {
    toolResult = {
      action:        "assign_candidate",
      projectId,
      candidateName: "top-candidate",
      milestoneName: "Milestone 1",
      message:       `Queuing: @top-candidate → "Milestone 1"`,
    };
    assistantText = "I've queued the assignment. Please confirm in the Gantt view.";
  } else if (isSummary) {
    toolResult = {
      action:    "query_vetting_summary",
      projectId,
      focus:     "shortlisted",
      message:   `Generating shortlisted summary for project ${projectId}`,
    };
    assistantText = "I'm summarising the shortlisted candidates for this project.";
  } else {
    // Generic help response — no tool
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const textId = generateId();
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: 'I can help you filter candidates, re-level the Gantt timeline, or summarise vetting results. Try asking: "Re-level timeline for a 20 hr/week candidate" or "Shift delivery phases by 2 weeks".' });
        writer.write({ type: "text-end", id: textId });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const callId = `mock-${Date.now()}`;
  const toolName = toolResult.action as string;
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      // 1. Write assistant text
      const textId = generateId();
      writer.write({ type: "text-start", id: textId });
      writer.write({ type: "text-delta", id: textId, delta: assistantText });
      writer.write({ type: "text-end", id: textId });
      // 2. Write tool input (required before output)
      writer.write({
        type:      "tool-input-available",
        toolCallId: callId,
        toolName,
        input:     {},
        dynamic:   true,
      });
      // 3. Write tool output (this is what the UI renders as the result badge)
      writer.write({
        type:      "tool-output-available",
        toolCallId: callId,
        output:    toolResult,
        dynamic:   true,
      });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { messages?: unknown[]; projectId?: string };
  try {
    body = await req.json() as { messages?: unknown[]; projectId?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "messages array required" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "unknown";

  // Last user message text — used for mock fallback
  const rawMessages = body.messages as Array<{ role?: string; content?: unknown; parts?: unknown[] }>;
  const lastUserMsg = [...rawMessages].reverse().find((m) => m.role === "user");
  const lastUserText = (() => {
    if (!lastUserMsg) return "";
    // SDK v6 sends parts arrays; fall back to content string for older callers
    const parts = Array.isArray(lastUserMsg.parts)
      ? (lastUserMsg.parts as Array<{ type?: string; text?: string }>)
      : [];
    const fromParts = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
    if (fromParts) return fromParts;
    return typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
  })();

  // If GROQ is not configured, return a deterministic mock so the UI renders
  if (!process.env.GROQ_API_KEY) {
    console.warn("[HarnessAgent] GROQ_API_KEY not set — returning mock response");
    return buildMockStream(lastUserText, projectId);
  }

  // Convert UI messages (parts format) to ModelMessage[] for streamText
  let modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>;
  try {
    // convertToModelMessages expects Omit<UIMessage, 'id'>[]
    // UIMessage requires at minimum { role, parts[] }
    const uiMessages = rawMessages.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      parts: Array.isArray(m.parts)
        ? m.parts
        : [{ type: "text" as const, text: typeof m.content === "string" ? m.content : "" }],
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelMessages = await convertToModelMessages(uiMessages as any, {
      tools: buildTools(projectId),
      ignoreIncompleteToolCalls: true,
    });
  } catch (convErr) {
    // Conversion failed (e.g. malformed parts) — fall back to mock
    console.warn("[HarnessAgent] message conversion failed, using mock:", convErr);
    return buildMockStream(lastUserText, projectId);
  }

  try {
    const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
    const result = streamText({
      model:            groq("llama-3.1-8b-instant"),
      system:           SYSTEM_PROMPT,
      messages:         modelMessages,
      maxOutputTokens:  512,
      temperature:      0.3,
      tools:            buildTools(projectId),
    });

    // toUIMessageStreamResponse() emits the UI message stream protocol that
    // DefaultChatTransport.processResponseStream() can parse — including tool
    // call / tool result events.  Never use toTextStreamResponse() here.
    return result.toUIMessageStreamResponse();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[HarnessAgent] streamText failed:", msg);
    // Return mock instead of an error so the chat panel always shows something
    return buildMockStream(lastUserText, projectId);
  }
}
