import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { Render } from "@renderinc/sdk";

import { db } from "@/lib/db";
import { deliveryWorkflowRuns } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const [stored] = await db
    .select()
    .from(deliveryWorkflowRuns)
    .where(eq(deliveryWorkflowRuns.id, runId))
    .limit(1);
  if (!stored) return NextResponse.json({ error: "Workflow run not found" }, { status: 404 });

  const details = await new Render().workflows.getTaskRun(stored.taskRunId);
  const status = details.status;
  await db.update(deliveryWorkflowRuns).set({
    status,
    result: details.results ?? null,
    error: details.error ?? null,
    updatedAt: new Date(),
  }).where(eq(deliveryWorkflowRuns.id, runId));
  return NextResponse.json({ ...stored, status, result: details.results ?? null, error: details.error ?? null });
}
