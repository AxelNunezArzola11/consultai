import { generateText, tool } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const requestSchema = z.object({
  message: z.string().min(1).max(4000),
  availableTasks: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
  })).max(500),
});

const scheduleTask = tool({
  description: "Schedule an available unscheduled task on the Gantt timeline.",
  inputSchema: z.object({
    taskId: z.union([z.string(), z.number()]).describe("The exact ID of the task to schedule."),
    targetStartDate: z.string().describe("The task start date in YYYY-MM-DD format."),
  }),
});

export async function POST(request: NextRequest) {
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid planning request." }, { status: 400 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI service is not configured. Set GROQ_API_KEY to enable planning chat." },
      { status: 503 }
    );
  }

  try {
    const groq = createGroq({ apiKey });
    const result = await generateText({
      model: groq(process.env.LLM_GROQ_MODEL ?? "llama-3.1-8b-instant"),
      system: [
        "You are a project scheduling assistant.",
        "Answer concisely in Markdown.",
        "Only schedule tasks that appear in the available task list.",
        "When the user asks to put, move, or schedule an available task on the Gantt, call scheduleTask.",
        "Use YYYY-MM-DD for targetStartDate. If no date is provided, use today's date.",
        `Available tasks: ${JSON.stringify(parsed.data.availableTasks)}`,
      ].join("\n"),
      prompt: parsed.data.message,
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
    return NextResponse.json({ error: "The planning AI request failed." }, { status: 502 });
  }
}
