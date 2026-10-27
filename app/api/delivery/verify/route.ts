/**
 * POST /api/delivery/verify
 *
 * Orchestrates the full Delivery Agent verification run:
 *   1. Parse + validate PR URL (repo must match DELIVERY_AGENT_REPO if set)
 *   2. Fetch PR details, files, check runs, reviews from GitHub
 *   3. Detect flags (workflow tamper, test delete, draft, wrong author)
 *   4. Run deterministic objective criterion checks
 *   5. Run LLM step (structured output, injection-safe, fallback on failure)
 *   6. Validate evidence refs (drop fabricated)
 *   7. Run policy engine (pure code — LLM cannot influence decision)
 *   8. Create verification_run + agent_steps + payment_proposal in DB
 *   9. Write audit log entry
 *  10. Return SSE-compatible response (each step streamed as server-sent events)
 *
 * Auth: requires role=company OR role=freelancer cookie (both can submit).
 *   The payout gate (company only) is enforced separately in /api/paypal/payout.
 *
 * Body: {
 *   milestoneId: string,
 *   prUrl: string,
 *   expectedAuthor?: string  -- optional expected GitHub login
 * }
 *
 * SSE events:
 *   { type: "step", step: AgentStepSummary }
 *   { type: "result", run: RunSummary, proposal: ProposalSummary }
 *   { type: "error", message: string }
 *
 * Rate limit: 10 verifications per IP per 5 minutes.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { milestones, verificationRuns, agentSteps, paymentProposals, projects, deliveryWorkflowRuns } from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import {
  parsePrUrl,
  validateRepo,
  fetchPRDetails,
  fetchPRFiles,
  fetchCheckRuns,
  fetchPRReviews,
  GitHubApiError,
} from "@/lib/delivery/github-client";
import {
  detectFlags,
  verifyObjectiveCriteria,
  type AcceptanceCriterion,
  type VerificationContext,
} from "@/lib/delivery/verifier";
import { runLlmStep } from "@/lib/delivery/llm-step";
import {
  evaluatePolicy,
  getAutoReleaseLimitUsd,
  type PolicyFlag,
} from "@/lib/delivery/policy-engine";
import { Render } from "@renderinc/sdk";
import { DeliveryWorkflowInputSchema } from "@/workflows/schemas";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Writes an agent step row and returns its id. */
async function recordStep(
  runId: string,
  seq: number,
  tool: string,
  inputSummary: string,
  outputSummary: string,
  status: "done" | "error",
  evidenceRefs?: string[],
  errorMessage?: string
): Promise<string> {
  const stepId = `step_${nanoid(10)}`;
  const now = new Date();
  await db.insert(agentSteps).values({
    id: stepId,
    runId,
    seq,
    tool,
    inputSummary,
    outputSummary,
    evidenceRefs: evidenceRefs ? evidenceRefs : null,
    status,
    startedAt: now,
    completedAt: now,
    errorMessage: errorMessage ?? null,
  });
  return stepId;
}

// ---------------------------------------------------------------------------
// Route handler — returns JSON (not streaming) for simplicity;
// UI polls /api/delivery/run/[id] for live updates
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: require any valid role ──────────────────────────────────────────
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (!role) {
    return NextResponse.json(
      { error: "Unauthorized — please select your role on the home page" },
      { status: 401 }
    );
  }

  // ── Rate limit: 10 verifications per IP per 5 minutes ─────────────────────
  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("delivery-verify", ip, 10, 300);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many verification requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  const startTime = Date.now();

  try {
    const body = await req.json().catch(() => null);
    const milestoneId = body?.milestoneId as string | undefined;
    const prUrl = body?.prUrl as string | undefined;
    const expectedAuthor = (body?.expectedAuthor as string | undefined) ?? undefined;

    if (!milestoneId || !prUrl) {
      return NextResponse.json(
        { error: "milestoneId and prUrl are required" },
        { status: 400 }
      );
    }

    // ── Load milestone + project ──────────────────────────────────────────
    const [milestone] = await db
      .select()
      .from(milestones)
      .where(eq(milestones.id, milestoneId))
      .limit(1);

    if (!milestone) {
      return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
    }

    // Load acceptance criteria from project
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, milestone.projectId))
      .limit(1);

    const criteria: AcceptanceCriterion[] = Array.isArray(project?.acceptanceCriteria)
      ? (project.acceptanceCriteria as AcceptanceCriterion[])
      : [];

    // ── Step 1: Parse + validate PR URL ───────────────────────────────────
    let parsedPr: { owner: string; repo: string; number: number };
    try {
      parsedPr = parsePrUrl(prUrl);
      validateRepo(parsedPr.owner, parsedPr.repo);
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 400 }
      );
    }

    if (process.env.DELIVERY_WORKFLOW_ENABLED === "true") {
      const idempotencyKey = `delivery:${milestoneId}:${prUrl}`;
      const existing = await db
        .select()
        .from(deliveryWorkflowRuns)
        .where(eq(deliveryWorkflowRuns.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing[0]) {
        return NextResponse.json({ workflowRunId: existing[0].id, taskRunId: existing[0].taskRunId, status: existing[0].status }, { status: 202 });
      }

      const workflowInput = DeliveryWorkflowInputSchema.parse({
        prUrl,
        expectedAuthor,
        criteria,
        amountUsd: parseFloat(milestone.budgetUsd ?? "0"),
      });
      const render = new Render();
      const taskRun = await render.workflows.startTask(
        `${process.env.DELIVERY_WORKFLOW_SLUG ?? "consultai-delivery"}/verifyDelivery`,
        [workflowInput],
        { idempotencyKey },
      );
      const workflowRunId = `workflow_${nanoid(12)}`;
      await db.insert(deliveryWorkflowRuns).values({
        id: workflowRunId,
        idempotencyKey,
        milestoneId,
        prUrl,
        taskRunId: taskRun.taskRunId,
        status: "pending",
      });
      await writeAuditLog({
        entityType: "milestone",
        entityId: milestoneId,
        event: "DELIVERY_WORKFLOW_TRIGGERED",
        actor: role,
        payload: { workflowRunId, taskRunId: taskRun.taskRunId, idempotencyKey },
      });
      return NextResponse.json({ workflowRunId, taskRunId: taskRun.taskRunId, status: "pending" }, { status: 202 });
    }

    // Create the verification run row (status=running)
    const runId = `run_${nanoid(12)}`;
    await db.insert(verificationRuns).values({
      id: runId,
      milestoneId,
      prUrl,
      prOwner: parsedPr.owner,
      prRepo: parsedPr.repo,
      prNumber: parsedPr.number,
      status: "running",
      submittedBy: role,
    });

    let seq = 0;
    const stepSummaries: { seq: number; tool: string; output: string }[] = [];

    // ── Step 2: Fetch PR data from GitHub ─────────────────────────────────
    let ctx: VerificationContext;
    try {
      const [pr, files, reviews] = await Promise.all([
        fetchPRDetails(parsedPr.owner, parsedPr.repo, parsedPr.number),
        fetchPRFiles(parsedPr.owner, parsedPr.repo, parsedPr.number),
        fetchPRReviews(parsedPr.owner, parsedPr.repo, parsedPr.number),
      ]);
      const checkRuns = await fetchCheckRuns(
        parsedPr.owner,
        parsedPr.repo,
        pr.headSha
      );
      ctx = { pr, files, checkRuns, reviews, expectedAuthor };

      const stepOutput = `PR #${pr.number} "${pr.title}" by ${pr.author} — ${files.length} files, ${checkRuns.length} checks, ${reviews.length} reviews. HEAD SHA: ${pr.headSha.substring(0, 8)}`;
      await recordStep(runId, seq++, "fetchPRDetails", `owner=${parsedPr.owner} repo=${parsedPr.repo} pr=${parsedPr.number}`, stepOutput, "done");
      stepSummaries.push({ seq: seq - 1, tool: "fetchPRDetails", output: stepOutput });

      // Update run with fetched PR details
      await db
        .update(verificationRuns)
        .set({
          headSha: pr.headSha,
          prAuthor: pr.author,
          prMerged: pr.merged,
          prDraft: pr.draft,
          updatedAt: new Date(),
        })
        .where(eq(verificationRuns.id, runId));
    } catch (err) {
      const msg = err instanceof GitHubApiError
        ? `GitHub API error ${err.status}: ${err.message}`
        : (err as Error).message;
      await recordStep(runId, seq++, "fetchPRDetails", `pr=${prUrl}`, msg, "error", undefined, msg);
      await db
        .update(verificationRuns)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(verificationRuns.id, runId));
      return NextResponse.json({ error: msg, runId }, { status: 502 });
    }

    // ── Step 3: Detect flags ───────────────────────────────────────────────
    const flags = detectFlags(ctx);
    const flagOutput = flags.length > 0
      ? `Flags: ${flags.join(", ")}`
      : "No flags raised";
    await recordStep(runId, seq++, "detectFlags", "checking files, PR metadata", flagOutput, "done");
    stepSummaries.push({ seq: seq - 1, tool: "detectFlags", output: flagOutput });

    // ── Step 4: Deterministic objective checks ─────────────────────────────
    const criteriaResults = verifyObjectiveCriteria(criteria, ctx);
    const passCount = criteriaResults.filter((r) => r.met === true).length;
    const failCount = criteriaResults.filter((r) => r.met === false).length;
    const checkOutput = `${passCount} passed, ${failCount} failed, ${criteriaResults.filter((r) => r.met === null).length} pending out of ${criteriaResults.length} criteria`;
    await recordStep(runId, seq++, "verifyAcceptanceCriteria", `${criteria.length} criteria`, checkOutput, "done",
      criteriaResults.flatMap((r) => r.evidence).slice(0, 20)
    );
    stepSummaries.push({ seq: seq - 1, tool: "verifyAcceptanceCriteria", output: checkOutput });

    // ── Step 5: LLM justification ──────────────────────────────────────────
    const llmResult = await runLlmStep(criteria, criteriaResults, ctx);
    const llmOutput = llmResult.fallback
      ? `Fallback: ${llmResult.output.justification.substring(0, 120)}`
      : `LLM (${llmResult.modelId}): ${llmResult.output.justification.substring(0, 120)}`;
    await recordStep(
      runId, seq++, "verifyAcceptanceCriteria_llm",
      `model=${llmResult.modelId} fallback=${llmResult.fallback}`,
      llmOutput, "done",
      llmResult.validatedSubjectiveAssessments.flatMap((a) => a.evidence).slice(0, 10)
    );
    stepSummaries.push({ seq: seq - 1, tool: "llmJustification", output: llmOutput });

    // Merge subjective assessments into criteriaResults
    for (const assessment of llmResult.validatedSubjectiveAssessments) {
      const idx = criteriaResults.findIndex((r) => r.criterionId === assessment.criterionId);
      if (idx >= 0) {
        criteriaResults[idx] = {
          ...criteriaResults[idx],
          met: assessment.met,
          evidence: [...criteriaResults[idx].evidence, ...assessment.evidence],
        };
      }
    }

    // ── Step 6: Policy engine ──────────────────────────────────────────────
    const amountUsd = parseFloat(milestone.budgetUsd ?? "0");
    const autoReleaseLimitUsd = getAutoReleaseLimitUsd();
    const policyOutput = evaluatePolicy({
      criteriaResults,
      flags: flags as PolicyFlag[],
      amountUsd,
      autoReleaseLimitUsd,
      shaMatches: true, // SHA just fetched — matches by definition at creation time
    });

    const policyStepOutput = `Decision: ${policyOutput.decision} — ${policyOutput.reasons.join("; ")}`;
    await recordStep(runId, seq++, "policyEngine", `amount=$${amountUsd} limit=$${autoReleaseLimitUsd}`, policyStepOutput, "done");
    stepSummaries.push({ seq: seq - 1, tool: "policyEngine", output: policyStepOutput });

    // ── Step 7: Create payment proposal ───────────────────────────────────
    const proposalId = `prop_${nanoid(12)}`;
    const proposalStatus = policyOutput.decision === "AUTO_RELEASE_ELIGIBLE"
      ? "auto_release_eligible" as const
      : policyOutput.decision === "REJECT_RECOMMENDED"
      ? "reject_recommended" as const
      : "requires_approval" as const;

    await db.insert(paymentProposals).values({
      id: proposalId,
      milestoneId,
      runId,
      boundHeadSha: ctx.pr.headSha,
      amountUsd: amountUsd.toFixed(2),
      policyDecision: policyOutput.decision,
      justification: llmResult.output.justification,
      justificationFallback: llmResult.fallback,
      status: proposalStatus,
    });

    // ── Step 8: Finalize run ───────────────────────────────────────────────
    const durationMs = Date.now() - startTime;
    await db
      .update(verificationRuns)
      .set({
        criteriaResults,
        flags,
        llmModelId: llmResult.modelId,
        promptVersion: (await import("@/lib/delivery/llm-step")).PROMPT_VERSION,
        durationMs,
        policyDecision: policyOutput.decision,
        justification: llmResult.output.justification,
        justificationFallback: llmResult.fallback,
        status: "completed",
        updatedAt: new Date(),
      })
      .where(eq(verificationRuns.id, runId));

    // Transition milestone → verifying
    if (milestone.status === "funded" || milestone.status === "submitted") {
      await db
        .update(milestones)
        .set({ status: "verifying", updatedAt: new Date() })
        .where(eq(milestones.id, milestoneId));
    }

    // ── Step 9: Audit log ──────────────────────────────────────────────────
    await writeAuditLog({
      entityType: "milestone",
      entityId: milestoneId,
      event: "DELIVERY_VERIFIED",
      actor: role,
      payload: {
        runId,
        proposalId,
        prUrl,
        headSha: ctx.pr.headSha.substring(0, 8),
        policyDecision: policyOutput.decision,
        flags,
        fallback: llmResult.fallback,
        durationMs,
      },
    });

    return NextResponse.json({
      status: "ok",
      runId,
      proposalId,
      policyDecision: policyOutput.decision,
      reasons: policyOutput.reasons,
      headSha: ctx.pr.headSha.substring(0, 8),
      justification: llmResult.output.justification,
      justificationFallback: llmResult.fallback,
      flags,
      criteriaResults,
      steps: stepSummaries,
      durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[delivery/verify] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
