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
 *   Live mode requires a verified session: company sessions are scoped to
 *   their own company's projects (D.3); freelancer sessions are scoped to
 *   projects they are assigned to, by session email and/or GitHub handle,
 *   and missing identity fails closed instead of skipping the check (D.2).
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
import { milestones, verificationRuns, agentSteps, paymentProposals, projects, candidates } from "@/lib/db/schema";
import { writeAuditLog } from "@/lib/db/audit";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
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
import { isDemoMode } from "@/lib/demo/config";

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
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (!role) {
    return NextResponse.json(
      { error: "Unauthorized — please select your role on the home page" },
      { status: 401 }
    );
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access); freelancer callers need a
  // verified session carrying identity (D.2 — missing email/GitHub
  // identity must not silently bypass assignment verification).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }
  if (role === "freelancer" && !isDemoMode()) {
    const gateEmail =
      session?.role === "freelancer" ? session.email.trim().toLowerCase() : "";
    const gateHandle =
      session?.role === "freelancer"
        ? (session.githubHandle ?? "").trim().toLowerCase()
        : "";
    if (!gateEmail && !gateHandle) {
      return NextResponse.json({ error: "missing_freelancer_identity" }, { status: 403 });
    }
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

    if (!milestoneId || typeof milestoneId !== "string" || milestoneId.length > 100 ||
        !prUrl || typeof prUrl !== "string" || prUrl.length > 2000) {
      return NextResponse.json(
        { error: "milestoneId and prUrl are required" },
        { status: 400 }
      );
    }
    if (expectedAuthor !== undefined &&
        (typeof expectedAuthor !== "string" || expectedAuthor.length > 100)) {
      return NextResponse.json({ error: "invalid expectedAuthor" }, { status: 400 });
    }

    // ── Load milestone + project ──────────────────────────────────────────
    const demoTables = isDemoMode() ? (await import("@/lib/demo/store")).getDemoTables() : null;
    const milestone = demoTables
      ? demoTables.milestones.find((m) => m.id === milestoneId)
      : (
          await db
            .select()
            .from(milestones)
            .where(eq(milestones.id, milestoneId))
            .limit(1)
        )[0];

    if (!milestone) {
      return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
    }

    // Load acceptance criteria from project
    const project = demoTables
      ? demoTables.projects.find((p) => p.id === milestone.projectId)
      : (
          await db
            .select()
            .from(projects)
            .where(eq(projects.id, milestone.projectId))
            .limit(1)
        )[0];

    // ── Ownership scoping ───────────────────────────────────────────────
    // Company callers: milestone's project must belong to the session company.
    // Freelancer callers: must be assigned to the project. Identity resolves
    // from the authenticated account (session email and/or GitHub handle);
    // in live mode the check always runs (the early gate guarantees a
    // session with identity), so a missing handle can no longer skip it.
    if (session?.role === "company" && session.companyId) {
      const ownerCompanyId = demoTables
        ? demoTables.projects.find((p) => p.id === milestone.projectId)?.companyId
        : project?.companyId;
      if (!ownerCompanyId || ownerCompanyId !== session.companyId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
    if (
      (!demoTables && role === "freelancer") ||
      (session?.role === "freelancer" && session.githubHandle)
    ) {
      const email =
        session?.role === "freelancer" ? session.email.trim().toLowerCase() : "";
      const handle =
        session?.role === "freelancer"
          ? (session.githubHandle ?? "").trim().toLowerCase()
          : "";
      let assigned: boolean;
      if (demoTables) {
        assigned = demoTables.candidates.some(
          (c) =>
            c.projectId === milestone.projectId &&
            (c.githubHandle ?? "").toLowerCase() === handle
        );
      } else {
        const projectCandidates = await db
          .select({ email: candidates.email, githubHandle: candidates.githubHandle })
          .from(candidates)
          .where(eq(candidates.projectId, milestone.projectId))
          .limit(200);
        assigned = projectCandidates.some(
          (c) =>
            (email !== "" && c.email.trim().toLowerCase() === email) ||
            (handle !== "" && (c.githubHandle ?? "").toLowerCase() === handle)
        );
      }
      if (!assigned) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const criteria: AcceptanceCriterion[] = Array.isArray(project?.acceptanceCriteria)
      ? (project.acceptanceCriteria as AcceptanceCriterion[])
      : [];

    // ── Step 1: Parse + validate PR URL ───────────────────────────────────
    let parsedPr: { owner: string; repo: string; number: number };
    try {
      parsedPr = parsePrUrl(prUrl);
      if (!demoTables) validateRepo(parsedPr.owner, parsedPr.repo);
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 400 }
      );
    }

    // ── Demo mode: simulated verification (no GitHub, no LLM) ─────────────
    // Objective criteria are marked met with simulated evidence; the REAL
    // policy engine still renders the decision. Everything is labeled simulated.
    if (demoTables) {
      const { appendDemoAudit } = await import("@/lib/demo/store");
      const runId = `demo-run-${nanoid(8)}`;
      const headSha = `demoheadsha${String(parsedPr.number).padStart(8, "0")}00000000000000000000`.slice(0, 40);
      const criteriaResults = criteria.map((c) => ({
        criterionId: c.id,
        kind: "objective" as const,
        met: true as boolean | null,
        evidence: [`simulated check passed for "${c.description.slice(0, 80)}"`],
      }));
      const amountUsd = parseFloat(milestone.budgetUsd ?? "0");
      const policyOutput = evaluatePolicy({
        criteriaResults,
        flags: [] as PolicyFlag[],
        amountUsd,
        autoReleaseLimitUsd: getAutoReleaseLimitUsd(),
        shaMatches: true,
      });
      const proposalId = `demo-prop-${nanoid(8)}`;
      const now = new Date();
      demoTables.verificationRuns.unshift({
        id: runId,
        milestoneId,
        prUrl,
        prOwner: parsedPr.owner,
        prRepo: parsedPr.repo,
        prNumber: parsedPr.number,
        headSha,
        prAuthor: expectedAuthor ?? "demo-contributor",
        prMerged: false,
        prDraft: false,
        criteriaResults,
        flags: [],
        llmModelId: "simulated-demo-model",
        promptVersion: "demo-v1",
        durationMs: 900,
        policyDecision: policyOutput.decision,
        justification: `SIMULATED verification of PR #${parsedPr.number}: all ${criteriaResults.length} criteria checks passed against fictional evidence. Policy decision rendered by the real policy engine.`,
        justificationFallback: false,
        status: "completed",
        submittedBy: role,
        createdAt: now,
        updatedAt: now,
      });
      demoTables.paymentProposals.unshift({
        id: proposalId,
        milestoneId,
        runId,
        boundHeadSha: headSha,
        amountUsd: amountUsd.toFixed(2),
        policyDecision: policyOutput.decision,
        justification: "Simulated proposal — human approval still required.",
        justificationFallback: false,
        status:
          policyOutput.decision === "AUTO_RELEASE_ELIGIBLE"
            ? "auto_release_eligible"
            : policyOutput.decision === "REJECT_RECOMMENDED"
              ? "reject_recommended"
              : "requires_approval",
        decidedBy: null,
        decidedAt: null,
        decisionNotes: null,
        createdAt: now,
        updatedAt: now,
      });
      if (milestone.status === "funded" || milestone.status === "submitted") {
        milestone.status = "verifying";
        milestone.updatedAt = now;
      }
      appendDemoAudit({
        entityType: "milestone",
        entityId: milestoneId,
        event: "DELIVERY_VERIFIED",
        actor: role,
        payload: { runId, proposalId, prUrl, policyDecision: policyOutput.decision },
      });
      return NextResponse.json({
        status: "ok",
        runId,
        proposalId,
        policyDecision: policyOutput.decision,
        reasons: policyOutput.reasons,
        headSha: headSha.substring(0, 8),
        justification: `SIMULATED verification of PR #${parsedPr.number} (no GitHub or LLM contacted).`,
        justificationFallback: false,
        flags: [],
        criteriaResults,
        steps: [
          { seq: 0, tool: "fetchPRDetails", output: `Simulated fetch of ${parsedPr.owner}/${parsedPr.repo}#${parsedPr.number}` },
          { seq: 1, tool: "verifyAcceptanceCriteria", output: `${criteriaResults.length} simulated checks passed` },
          { seq: 2, tool: "policyEngine", output: `Decision: ${policyOutput.decision}` },
        ],
        durationMs: 900,
        simulated: true,
      });
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
