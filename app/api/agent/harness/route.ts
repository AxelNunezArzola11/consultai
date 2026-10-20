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
 * Security:
 *   - Only projectId + text messages accepted from the client.
 *   - No DB writes — tools return instructions for the client to execute.
 */

import { streamText, tool, zodSchema } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { z } from "zod";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 25;

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY ?? "" });

const SYSTEM_PROMPT = `You are ConsultAI's in-product AI assistant, integrated with AG Grid (candidate matrix) and Bryntum Gantt (project timeline).

You have access to five tools:
1. filter_candidates       — narrow down candidates by trust score, skill, or status.
2. assign_candidate        — assign a candidate to a milestone.
3. reschedule_milestone    — move a single milestone to a new date.
4. query_vetting_summary   — summarise vetting results.
5. smart_reschedule_gantt  — intelligently re-level the entire timeline based on capacity or shift delivery phases.

When the user asks to re-level, re-schedule based on availability (e.g. "20 hr/week candidate"), or shift delivery phases by N weeks, always use smart_reschedule_gantt.

Always respond in plain English. Keep replies concise. Acknowledge when you lack information.`;

export async function POST(req: NextRequest) {
  if (!process.env.GROQ_API_KEY) {
    return Response.json({ error: "GROQ_API_KEY not configured" }, { status: 503 });
  }

  let body: { messages: unknown[]; projectId?: string };
  try {
    body = await req.json() as { messages: unknown[]; projectId?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "messages array required" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "unknown";

  const messages = (body.messages as Array<{ role?: string; content?: string }>).map((m) => ({
    role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
    content: String(m.content ?? ""),
  }));

  try {
    const result = streamText({
      model: groq("llama-3.1-8b-instant"),
      system: SYSTEM_PROMPT,
      messages,
      maxOutputTokens: 512,
      temperature: 0.3,
      tools: {
        filter_candidates: tool({
          description: "Filter the candidate list by minimum trust score, required skill, or shortlist status.",
          inputSchema: zodSchema(z.object({
            minTrustScore: z.number().min(0).max(100).optional().describe("Minimum trust score (0–100)"),
            skill: z.string().optional().describe("Required skill keyword"),
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
            newStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("New start date YYYY-MM-DD"),
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
            // Helper: parse a YYYY-MM-DD string to a JS Date at midnight UTC
            const parseDate = (s: string | null): Date | null => {
              if (!s) return null;
              const d = new Date(s + "T00:00:00Z");
              return isNaN(d.getTime()) ? null : d;
            };

            // Helper: format a Date back to YYYY-MM-DD
            const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);

            // Helper: add days to a Date (returns new Date)
            const addDays = (d: Date, days: number): Date =>
              new Date(d.getTime() + days * 86_400_000);

            // -----------------------------------------------------------------
            // Build updated milestone list based on intent
            // -----------------------------------------------------------------
            const updated = mlList.map((m) => {
              const start = parseDate(m.startDate);
              const due   = parseDate(m.dueDate);

              if (intent === "shift_phases") {
                const weeks = shiftWeeks ?? 1;
                const days = Math.round(weeks * 7);
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
                const durationMs = due.getTime() - start.getTime();
                const newDurationMs = Math.max(1, Math.round(durationMs * factor));
                const newDue = new Date(start.getTime() + newDurationMs);
                return {
                  id:        m.id,
                  title:     m.title,
                  startDate: m.startDate,
                  dueDate:   fmtDate(newDue),
                };
              }

              if (intent === "relevel_capacity") {
                // Standard full-time = 40 hr/week. Scale durations proportionally.
                const hrs = weeklyHours ?? 20;
                const factor = 40 / Math.max(1, hrs);
                if (!start || !due) return m;
                const durationMs = due.getTime() - start.getTime();
                const newDurationMs = Math.max(86_400_000, Math.round(durationMs * factor)); // min 1 day
                const newDue = new Date(start.getTime() + newDurationMs);
                return {
                  id:        m.id,
                  title:     m.title,
                  startDate: m.startDate,
                  dueDate:   fmtDate(newDue),
                };
              }

              return m;
            });

            const intentLabels: Record<string, string> = {
              relevel_capacity:  `re-levelled for ${weeklyHours ?? 20} hr/week`,
              shift_phases:      `shifted ${shiftWeeks && shiftWeeks > 0 ? "+" : ""}${shiftWeeks ?? 1} week(s)`,
              compress_timeline: `compressed to ${Math.round((scaleFactor ?? 0.75) * 100)}%`,
              expand_timeline:   `expanded to ${Math.round((scaleFactor ?? 1.33) * 100)}%`,
            };

            return {
              action:   "smart_reschedule_gantt",
              projectId,
              intent,
              updates:  updated,
              message:  `Timeline ${intentLabels[intent] ?? intent}. ${updated.length} milestone(s) updated. Review and save to apply.`,
            };
          },
        }),
      },
    });

    return result.toTextStreamResponse();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[HarnessAgent]", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
