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
 * Modes & Honesty Policy:
 *   - DEMO mode (isDemoMode() === true): Uses deterministic context-aware simulation
 *     explicitly labeled "DEMO MODE — Simulated Response".
 *   - LIVE mode (isDemoMode() === false):
 *     - Requires authenticated company or admin role.
 *     - Loads active project, milestones, and candidates from DB into the system prompt.
 *     - Calls Groq live inference. If tool-calling fails on an open-ended question,
 *       retries live text-only inference on Groq.
 *     - If GROQ_API_KEY is missing or the live provider fails, returns a clear,
 *       honest provider error message — NEVER claims a live response is simulated
 *       or a simulated response is live.
 */

import {
  streamText,
  generateText,
  tool,
  zodSchema,
  convertToModelMessages,
  createUIMessageStreamResponse,
  createUIMessageStream,
  generateId,
} from "ai";
import { createGroq } from "@ai-sdk/groq";
import { z } from "zod";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, candidates, milestones as milestonesTable } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";

export const runtime = "nodejs";
export const maxDuration = 25;

interface ProjectContextSummary {
  projectId: string;
  projectTitle: string;
  projectStatus: string;
  candidateLines: string[];
  milestoneLines: string[];
}

async function loadProjectContext(projectId: string): Promise<ProjectContextSummary> {
  if (isDemoMode()) {
    try {
      const { getDemoTables } = await import("@/lib/demo/store");
      const t = getDemoTables();
      const proj = t.projects.find((p) => p.id === projectId) ?? t.projects[0];
      const cands = t.candidates.filter((c) => c.projectId === (proj?.id ?? projectId));
      const mls = t.milestones.filter((m) => m.projectId === (proj?.id ?? projectId));
      return {
        projectId: proj?.id ?? projectId,
        projectTitle: proj?.title ?? `Project ${projectId}`,
        projectStatus: proj?.status ?? "active",
        candidateLines: cands.map(
          (c) =>
            `- ${c.name} (@${c.githubHandle ?? "n/a"}): status=${c.status}, trustScore=${c.trustScore ?? "unvetted"}, rank=${c.rank ?? "-"}`
        ),
        milestoneLines: mls.map(
          (m) =>
            `- ${m.title}: status=${m.status}, amount=$${Number(m.budgetUsd ?? 0).toFixed(0)}, due=${m.dueDate ?? "TBD"}`
        ),
      };
    } catch {
      return {
        projectId,
        projectTitle: `Project ${projectId}`,
        projectStatus: "active",
        candidateLines: [],
        milestoneLines: [],
      };
    }
  }

  try {
    const [proj] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const cands = await db
      .select()
      .from(candidates)
      .where(eq(candidates.projectId, projectId));
    const mls = await db
      .select()
      .from(milestonesTable)
      .where(eq(milestonesTable.projectId, projectId));

    return {
      projectId,
      projectTitle: proj?.title ?? `Project ${projectId}`,
      projectStatus: proj?.status ?? "active",
      candidateLines: cands.map(
        (c) =>
          `- ${c.name} (@${c.githubHandle ?? "n/a"}): status=${c.status}, trustScore=${c.trustScore ?? "unvetted"}, rank=${c.rank ?? "-"}`
      ),
      milestoneLines: mls.map(
        (m) =>
          `- ${m.title}: status=${m.status}, amount=$${Number(m.budgetUsd ?? 0).toFixed(0)}, due=${m.dueDate ?? "TBD"}`
      ),
    };
  } catch {
    return {
      projectId,
      projectTitle: `Project ${projectId}`,
      projectStatus: "active",
      candidateLines: [],
      milestoneLines: [],
    };
  }
}

function buildSystemPrompt(ctx: ProjectContextSummary): string {
  const candidatesBlock =
    ctx.candidateLines.length > 0
      ? ctx.candidateLines.join("\n")
      : "No candidates recorded for this project yet.";
  const milestonesBlock =
    ctx.milestoneLines.length > 0
      ? ctx.milestoneLines.join("\n")
      : "No milestones recorded for this project yet.";

  return `You are ConsultAI's in-product AI Vetting & Project Operations Assistant, integrated with AG Grid (candidate matrix) and Bryntum Gantt (project timeline).

Active Project Context:
- Project ID: ${ctx.projectId}
- Title: ${ctx.projectTitle}
- Status: ${ctx.projectStatus}

Candidates in Pipeline:
${candidatesBlock}

Project Milestones:
${milestonesBlock}

Available Tools (ONLY invoke a tool when the user explicitly asks to perform an action on the grid or timeline):
1. filter_candidates       — narrow down candidates by trust score, skill, or status.
2. assign_candidate        — assign a candidate to a milestone.
3. reschedule_milestone    — move a single milestone to a new date.
4. query_vetting_summary   — summarise vetting results.
5. smart_reschedule_gantt  — intelligently re-level the entire timeline based on capacity or shift delivery phases.

Instructions:
- For open-ended questions (e.g., comparing candidates, explaining vetting scores, discussing project risks, or recommending next steps), answer directly in clear, concise, authoritative plain English using the Active Project Context above without calling a tool unless needed.
- Never fabricate verification evidence or claim external actions occurred when they did not.`;
}

function isActionIntent(userText: string): boolean {
  const lower = userText.toLowerCase();
  return (
    /\b(re.?level|reschedul|shift\s+(?:all\s+)?(?:delivery\s+)?phases|compress\s+timeline|expand\s+timeline)\b/i.test(lower) ||
    /\b(filter\s+by|show\s+candidates\s+with|only\s+shortlisted)\b/i.test(lower) ||
    /\b(assign\s+@?[a-z0-9_-]+\s+to)\b/i.test(lower)
  );
}

// ── Tool definitions (shared between live + demo paths) ────────────────────────

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
          "relevel_capacity",
          "shift_phases",
          "compress_timeline",
          "expand_timeline",
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
        })).optional().describe("Current milestone list from the Gantt (id, title, startDate, dueDate)"),
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

        const workingList = (mlList && mlList.length > 0) ? mlList : [
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

// ── DEMO simulation content builder (only used when isDemoMode() === true) ───

interface MockContent {
  assistantText: string;
  toolResult: Record<string, unknown> | null;
}

function buildDemoChunks(
  userText: string,
  projectId: string,
  ctx: ProjectContextSummary
): MockContent {
  const mock = buildDemoChunksRaw(userText, projectId, ctx);
  return {
    assistantText:
      "[DEMO MODE — Simulated Response] " + mock.assistantText,
    toolResult: mock.toolResult
      ? { ...mock.toolResult, simulated: true }
      : null,
  };
}

function buildDemoChunksRaw(
  userText: string,
  projectId: string,
  ctx: ProjectContextSummary
): MockContent {
  const lower = userText.toLowerCase();
  const isReschedule = /re.?level|hr.*week|week.*hr|shift|reschedul|timeline|capacity/i.test(lower);
  const isFilter     = /filter|trust\s*score\s*>\s*\d+|only\s*shortlisted/i.test(lower);
  const isAssign     = /assign\s+/i.test(lower);

  if (isReschedule) {
    const weeklyHoursMatch = lower.match(/(\d+)\s*hr/);
    const weeklyHours = weeklyHoursMatch ? parseInt(weeklyHoursMatch[1], 10) : 20;
    const shiftWeeksMatch  = lower.match(/(\d+)\s*week/);
    const shiftWeeks  = shiftWeeksMatch  ? parseInt(shiftWeeksMatch[1],  10) : 2;
    const isShift = /shift|push|move/i.test(lower);
    const today   = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const add = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
    const factor = isShift ? 1 : (40 / Math.max(1, weeklyHours));
    const shift  = isShift ? shiftWeeks * 7 : 0;
    const demos  = [
      { id: "demo-1", title: "Discovery & Planning",  start: today,           dur: 14 },
      { id: "demo-2", title: "Core Development",       start: add(today, 15),  dur: 42 },
      { id: "demo-3", title: "Testing & QA",           start: add(today, 58),  dur: 14 },
      { id: "demo-4", title: "Deployment & Handoff",   start: add(today, 73),  dur: 7  },
    ];
    const updates = demos.map((d) => ({
      id:        d.id,
      title:     d.title,
      startDate: fmt(add(d.start, shift)),
      dueDate:   fmt(add(add(d.start, shift), Math.max(1, Math.round(d.dur * factor)))),
    }));
    return {
      assistantText: isShift
        ? `I've shifted the project timeline by ${shiftWeeks} week(s). Click "Apply to Timeline" to update the Gantt.`
        : `I've re-levelled the timeline for a ${weeklyHours} hr/week candidate. Durations are scaled by ×${(40 / weeklyHours).toFixed(2)} vs a full-time 40-hr baseline. Click "Apply to Timeline" to update the Gantt.`,
      toolResult: {
        action:  "smart_reschedule_gantt",
        projectId,
        intent:  isShift ? "shift_phases" : "relevel_capacity",
        updates,
        message: isShift
          ? `Calculated timeline shift for ${shiftWeeks} week(s) — ${updates.length} milestone(s) updated.`
          : `Calculated timeline shift for ${weeklyHours} hr/week — ${updates.length} milestone(s) updated. Review and click "Apply to Timeline".`,
      },
    };
  }

  if (isFilter) {
    const scoreMatch = lower.match(/(\d+)/);
    const minScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 70;
    const skillMatch = lower.match(/by\s+([a-z0-9.+_-]+)\s+skill/i);
    const skill = skillMatch ? skillMatch[1] : undefined;
    return {
      assistantText: skill
        ? `I've filtered the candidate grid for skill "${skill}".`
        : `I've applied a trust score ≥ ${minScore} filter to the candidate grid.`,
      toolResult: {
        action: "filter_candidates",
        projectId,
        criteria: skill ? { skill } : { minTrustScore: minScore },
        message: skill ? `Filter: skill "${skill}"` : `Filter: trust ≥ ${minScore}`,
      },
    };
  }

  if (isAssign) {
    return {
      assistantText: "I've queued the assignment. Please confirm in the Gantt view.",
      toolResult: {
        action:        "assign_candidate",
        projectId,
        candidateName: "top-candidate",
        milestoneName: "Milestone 1",
        message:       `Queuing: @top-candidate → "Milestone 1"`,
      },
    };
  }

  // Open-ended question in DEMO mode: provide context-aware answer from demo project data
  const candidateSummary =
    ctx.candidateLines.length > 0
      ? `Current candidates for "${ctx.projectTitle}":\n${ctx.candidateLines.join("\n")}`
      : `No candidates are registered yet for "${ctx.projectTitle}".`;
  const milestoneSummary =
    ctx.milestoneLines.length > 0
      ? `\n\nActive milestones:\n${ctx.milestoneLines.join("\n")}`
      : "";

  return {
    assistantText: `Based on the project "${ctx.projectTitle}" (${ctx.projectStatus}):\n\n${candidateSummary}${milestoneSummary}\n\nYou can ask me to filter candidates by trust score or skill, compare top candidates, or re-level the Bryntum Gantt timeline.`,
    toolResult: null,
  };
}

function buildTextStreamResponse(text: string, toolResult?: Record<string, unknown> | null): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const textId = generateId();
      writer.write({ type: "text-start", id: textId });
      writer.write({ type: "text-delta", id: textId, delta: text });
      writer.write({ type: "text-end",   id: textId });
      if (toolResult) {
        const callId = `tool-${Date.now()}`;
        writer.write({
          type: "tool-input-available",
          toolCallId: callId,
          toolName: toolResult.action as string,
          input: {},
          dynamic: true,
        });
        writer.write({
          type: "tool-output-available",
          toolCallId: callId,
          output: toolResult,
          dynamic: true,
        });
      }
    },
  });
  return createUIMessageStreamResponse({ stream });
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Authorization check: requires company or admin role
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return Response.json(
      { error: "Forbidden: Vetting Assistant requires company or admin role." },
      { status: 403 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return Response.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("agent-harness", ip, 20, 60);
  if (!ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  // Parse body
  let body: { messages?: unknown[]; projectId?: string };
  try {
    body = (await req.json()) as { messages?: unknown[]; projectId?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "messages array required" }, { status: 400 });
  }
  if (body.messages.length > 100) {
    return Response.json({ error: "messages array too large" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId || projectId.length > 100) {
    return Response.json({ error: "projectId required" }, { status: 400 });
  }

  if (session?.role === "company" && session.companyId) {
    let ownerCompanyId: string | null | undefined;
    if (isDemoMode()) {
      const { getDemoTables } = await import("@/lib/demo/store");
      ownerCompanyId = getDemoTables().projects.find((p) => p.id === projectId)?.companyId;
    } else {
      const [project] = await db
        .select({ companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      ownerCompanyId = project?.companyId;
    }
    if (!ownerCompanyId || ownerCompanyId !== session.companyId) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  }

  // Extract last user message text
  const rawMessages = body.messages as Array<{ role?: string; content?: unknown; parts?: unknown[] }>;
  const lastUserMsg = [...rawMessages].reverse().find((m) => m.role === "user");
  const lastUserText = (() => {
    if (!lastUserMsg) return "";
    const parts = Array.isArray(lastUserMsg.parts)
      ? (lastUserMsg.parts as Array<{ type?: string; text?: string }>)
      : [];
    const fromParts = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
    if (fromParts) return fromParts;
    return typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
  })();

  // Load real project/candidate/milestone context
  const projectContext = await loadProjectContext(projectId);

  // 1. DEMO MODE: deterministic, context-aware simulated response explicitly labeled
  if (isDemoMode()) {
    const demo = buildDemoChunks(lastUserText, projectId, projectContext);
    return buildTextStreamResponse(demo.assistantText, demo.toolResult);
  }

  // 2. LIVE MODE: verify AI provider configuration
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error: "ai_provider_unconfigured",
        message: "Live AI provider (Groq) is not configured. Set GROQ_API_KEY or enable DEMO_MODE.",
      },
      { status: 503 }
    );
  }

  const systemPrompt = buildSystemPrompt(projectContext);
  const groq = createGroq({ apiKey });
  const modelName = process.env.LLM_GROQ_MODEL || "llama-3.3-70b-versatile";

  try {
    const uiMessages = rawMessages.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      parts: Array.isArray(m.parts)
        ? m.parts
        : [{ type: "text" as const, text: typeof m.content === "string" ? m.content : "" }],
    }));

    const useTools = isActionIntent(lastUserText);
    const tools = useTools ? buildTools(projectId) : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelMessages = await convertToModelMessages(uiMessages as any, {
      ...(tools ? { tools } : {}),
      ignoreIncompleteToolCalls: true,
    });

    // For open-ended questions (or as primary path), use generateText or streamText
    // and fall back to text-only live call if tool-calling schema fails on Groq.
    if (!useTools) {
      try {
        const { text } = await generateText({
          model: groq(modelName),
          system: systemPrompt,
          messages: modelMessages,
          maxOutputTokens: 600,
          temperature: 0.3,
        });
        return buildTextStreamResponse(text.trim() || "No response generated by the model.");
      } catch (primaryErr) {
        // Fallback to llama-3.1-8b-instant in case the primary model is rate-limited
        const { text } = await generateText({
          model: groq("llama-3.1-8b-instant"),
          system: systemPrompt,
          messages: modelMessages,
          maxOutputTokens: 600,
          temperature: 0.3,
        });
        void primaryErr;
        return buildTextStreamResponse(text.trim() || "No response generated by the model.");
      }
    }

    const result = streamText({
      model:           groq(modelName),
      system:          systemPrompt,
      messages:        modelMessages,
      maxOutputTokens: 512,
      temperature:     0.2,
      tools,
    });

    const llmStream = result.toUIMessageStream();
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const reader = llmStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && typeof value === "object" && (value as { type?: string }).type === "error") {
              const errText = (value as { errorText?: string }).errorText ?? "AI provider stream error";
              reader.cancel().catch(() => {});
              // Retry once without tools so open-ended or borderline queries still get a real LIVE AI response
              try {
                const { text: retryText } = await generateText({
                  model: groq("llama-3.1-8b-instant"),
                  system: systemPrompt,
                  messages: modelMessages,
                  maxOutputTokens: 512,
                  temperature: 0.3,
                });
                const textId = generateId();
                writer.write({ type: "text-start", id: textId });
                writer.write({ type: "text-delta", id: textId, delta: retryText });
                writer.write({ type: "text-end",   id: textId });
              } catch {
                const textId = generateId();
                writer.write({ type: "text-start", id: textId });
                writer.write({
                  type: "text-delta",
                  id: textId,
                  delta: `AI Provider Error: Unable to complete live inference (${errText}). Please retry in a moment.`,
                });
                writer.write({ type: "text-end", id: textId });
              }
              break;
            }
            writer.write(value);
          }
        } catch (pumpErr) {
          const msg = pumpErr instanceof Error ? pumpErr.message : "Live AI stream interrupted";
          const textId = generateId();
          writer.write({ type: "text-start", id: textId });
          writer.write({
            type: "text-delta",
            id: textId,
            delta: `AI Provider Error: ${msg}`,
          });
          writer.write({ type: "text-end", id: textId });
        } finally {
          reader.releaseLock();
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected AI provider failure";
    return Response.json(
      { error: "ai_inference_failed", message: `Live AI inference failed: ${msg}` },
      { status: 502 }
    );
  }
}
