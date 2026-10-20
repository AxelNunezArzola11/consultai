/**
 * POST /api/agent/harness
 *
 * In-Product AI Agent Harness — Conversation Manager for Vetting & Gantt operations.
 *
 * Architecture (PayPal AG Grid boilerplate pattern):
 *   Chat UI → Harness (Conversation Manager) → Agents → Tools (AG Grid & Bryntum APIs)
 *
 * Tools:
 *   - filter_candidates  — filter AG Grid candidate table by criteria
 *   - assign_candidate   — assign candidate to Gantt milestone
 *   - reschedule_milestone — reschedule Gantt milestone to new start date
 *   - query_vetting_summary — natural-language summary of vetting scores
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

You have access to four tools:
1. filter_candidates — narrow down candidates by trust score, skill, or status.
2. assign_candidate — assign a candidate to a milestone.
3. reschedule_milestone — move a milestone to a new date.
4. query_vetting_summary — summarise vetting results.

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
      },
    });

    return result.toTextStreamResponse();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[HarnessAgent]", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
