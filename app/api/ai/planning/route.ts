import { generateText, tool } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runSupervisorWorkflow } from "@/lib/ai-ops/orchestrator-engine";
import { isDemoMode } from "@/lib/demo/config";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";

export const runtime = "nodejs";

const requestSchema = z.object({
  message: z.string().min(1).max(4000),
  projectId: z.string().optional(),
  availableTasks: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]),
        name: z.string(),
      })
    )
    .max(500)
    .optional()
    .default([]),
});

const scheduleTask = tool({
  description:
    "Propose scheduling an unscheduled backlog task onto the Gantt timeline (requires human authorization before mutating baseline).",
  inputSchema: z.object({
    taskId: z
      .union([z.string(), z.number()])
      .describe("The exact ID of the task to schedule."),
    targetStartDate: z
      .string()
      .describe("The proposed task start date in YYYY-MM-DD format."),
  }),
});

export async function POST(request: NextRequest) {
  const role = await getRoleFromCookie(request.headers.get("cookie"));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: planning AI requires the company or admin role." },
      { status: 403 }
    );
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid planning request." },
      { status: 400 }
    );
  }

  const { message, projectId, availableTasks } = parsed.data;
  const q = message.toLowerCase();

  // Route delay/reschedule or full WBS plan requests through the Multi-Agent Supervisor
  // so they generate a validated SchedulingProposal requiring human authorization.
  const isRescheduleOrPlan =
    /(delay|reschedul|shift|slip|postpone|cascade|critical path|plan|wbs|baseline|milestone)/.test(
      q
    );

  if (isRescheduleOrPlan) {
    try {
      const opType = /(delay|reschedul|shift|slip|postpone|cascade)/.test(q)
        ? "schedule_reschedule"
        : "project_planning";

      // Extract numeric delay days if mentioned (e.g., "delay by 3 days")
      const dayMatch = q.match(/(\d+)\s*day/);
      const delayDays = dayMatch ? parseInt(dayMatch[1], 10) : 3;

      const workflowResult = await runSupervisorWorkflow({
        userRequest: message,
        operationType: opType,
        projectId,
        actorRole: "company",
        actorId: "planning-copilot-operator",
        context: { delay_days: delayDays },
      });

      const proposal =
        workflowResult.scheduling_proposals?.[0] ?? null;

      return NextResponse.json({
        text:
          `### ✦ Multi-Agent Scheduling Proposal Generated\n\n` +
          `${workflowResult.final_result}\n\n` +
          `**Execution ID:** \`${workflowResult.execution_id}\`\n` +
          `**Governance Policy:** Per Section 6 security rules, AI agents return validated scheduling proposals and never mutate project schedules without explicit human authorization. Use the **Authorize & Apply Proposal** banner above the Gantt chart to commit these adjustments.`,
        executionId: workflowResult.execution_id,
        schedulingProposal: proposal,
        toolCalls: [],
      });
    } catch (err) {
      console.warn("[planning-ai] Supervisor delegation warning:", err);
    }
  }

  if (isDemoMode()) {
    return NextResponse.json(
      {
        error:
          "Planning chat requires live AI services, which are unavailable in offline demo mode. " +
          "Try a reschedule request (e.g. 'delay frontend by 3 days') to run the simulated Supervisor workflow.",
      },
      { status: 503 }
    );
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "AI service is not configured. Set GROQ_API_KEY to enable planning chat.",
      },
      { status: 503 }
    );
  }

  try {
    const groq = createGroq({ apiKey });
    const result = await generateText({
      model: groq(process.env.LLM_GROQ_MODEL ?? "llama-3.3-70b-versatile"),
      system: [
        "You are ConsultAI's Principal Project Scheduling Assistant.",
        "Answer concisely in Markdown.",
        "IMPORTANT GOVERNANCE RULE: You never modify locked ('funded' or 'paid') milestones, and all schedule adjustments are returned as proposals requiring human authorization.",
        "Only reference backlog tasks that appear in the available task list.",
        "When the user asks to propose scheduling an available backlog task onto the Gantt, call scheduleTask.",
        "Use YYYY-MM-DD for targetStartDate. If no date is provided, use today's date.",
        `Available tasks: ${JSON.stringify(availableTasks)}`,
      ].join("\n"),
      prompt: message,
      tools: { scheduleTask },
    });

    return NextResponse.json({
      text: result.text,
      toolCalls: result.toolCalls.map((call) => ({
        toolName: call.toolName,
        input: call.input,
      })),
    });
  } catch (error) {
    console.error("[planning-ai] request failed:", error);
    return NextResponse.json(
      { error: "The planning AI request failed." },
      { status: 502 }
    );
  }
}
