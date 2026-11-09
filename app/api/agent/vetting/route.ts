/**
 * POST /api/agent/vetting
 *
 * Runs the VettingAgent for a single candidate.
 * Returns JSON with trust score, matrix, signals.
 *
 * Body:
 *   {
 *     candidateId: string
 *     projectId: string
 *   }
 *
 * Security:
 *   - Requires company role cookie.
 *   - candidateId + projectId are validated against DB.
 *   - Candidate must have given vetting consent (vetting_consent_at IS NOT NULL).
 *   - All source fetching is SSRF-safe (see ssrf-safe-fetch.ts).
 *   - LinkedIn URLs are never fetched.
 *
 * Human-review notice: always present in the response.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { candidates, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { runVetting } from "@/lib/vetting/orchestrator";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { requirementsFromProject } from "@/lib/vetting/requirements-from-project";
import { isDemoMode } from "@/lib/demo/config";

export async function POST(request: NextRequest) {
  // Role check
  const cookieHeader = request.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(request);
  const { ok, retryAfterSec } = checkRateLimit("vetting", ip, 10, 300);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: { candidateId?: string; projectId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { candidateId, projectId } = body;
  if (!candidateId || typeof candidateId !== "string" || candidateId.length > 100 ||
      !projectId || typeof projectId !== "string" || projectId.length > 100) {
    return NextResponse.json(
      { error: "candidateId and projectId are required" },
      { status: 400 }
    );
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const {
      computeTrustScore,
      buildMatrix,
      buildScoreBreakdown,
    } = await import("@/lib/vetting/signals");
    const t = getDemoTables();
    const candidate = t.candidates.find(
      (c) => c.id === candidateId && c.projectId === projectId
    );
    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }
    if (!candidate.vettingConsentAt) {
      return NextResponse.json(
        {
          error: "Candidate has not given vetting consent",
          humanReviewNotice:
            "A candidate must give in-app consent before vetting begins.",
        },
        { status: 403 }
      );
    }
    const project = t.projects.find((p) => p.id === projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId &&
        project.companyId !== session.companyId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    // Deterministic simulated run over the fixture signals — same scoring code.
    const demoSignals = t.signals
      .filter((s) => s.candidateId === candidateId)
      .map((s) => ({
        id: s.id,
        candidateId: s.candidateId,
        requirementId: s.requirementId,
        signalType: s.signalType as
          | "github_repo"
          | "github_pr"
          | "portfolio"
          | "public_review"
          | "provided_link",
        sourceUrl: s.sourceUrl,
        retrievedAt: s.retrievedAt.toISOString(),
        contentHash: s.contentHash,
        extractedFact: s.extractedFact,
        quotedExcerpt: s.quotedExcerpt,
        confidence: parseFloat(s.confidence),
      }));
    const requirements = requirementsFromProject(project);
    const trustScore = computeTrustScore(demoSignals);
    candidate.trustScore = trustScore.toFixed(2);
    candidate.vettingRanAt = new Date();
    candidate.updatedAt = new Date();
    return NextResponse.json({
      humanReviewNotice:
        "SIMULATED vetting run over fictional demo signals. It is intended to assist your " +
        "decision-making, not replace it. The company always makes the final hiring decision.",
      scoringFormula:
        "Trust score = Σ(signal_weight × confidence) / Σ(signal_weight), clamped to [0,1], rounded to 2dp. " +
        "Weights: github_repo=0.35, github_pr=0.30, portfolio=0.20, public_review=0.10, provided_link=0.05.",
      candidateId,
      trustScore,
      scoreBreakdown: buildScoreBreakdown(demoSignals),
      matrix: buildMatrix(requirements, demoSignals),
      signalCount: demoSignals.length,
      fabricatedDropped: 0,
      usedFallback: false,
      errors: [],
      simulated: true,
      debugPayload: {
        requirementsSent: requirements,
        debugLog: [
          {
            source: "demo-fixtures",
            note: "Deterministic simulated run — no external fetch, no live LLM.",
          },
        ],
      },
    });
  }

  // Validate candidate belongs to project
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(
      and(eq(candidates.id, candidateId), eq(candidates.projectId, projectId))
    );

  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  // Load project to get required skills for vetting
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (session?.role === "company" && session.companyId &&
      project.companyId !== session.companyId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Derive requirements from whatever project data is available.
  // Priority: structuredBrief.goals → structuredPlan milestones → project title.
  // This guarantees requirements is never empty — an empty array causes the LLM
  // to produce zero matches and a trust score of 0 for every candidate.
  const requirements = requirementsFromProject(project);

  try {
    const result = await runVetting({
      candidateId,
      projectId,
      requirements,
    });

    return NextResponse.json({
      // Human-review notice — always present
      humanReviewNotice:
        "This vetting report is generated by an AI agent from public sources. " +
        "It is intended to assist your decision-making, not replace it. " +
        "The company always makes the final hiring decision.",

      // Scoring transparency
      scoringFormula:
        "Trust score = Σ(signal_weight × confidence) / Σ(signal_weight), clamped to [0,1], rounded to 2dp. " +
        "Weights: github_repo=0.35, github_pr=0.30, portfolio=0.20, public_review=0.10, provided_link=0.05.",

      candidateId: result.candidateId,
      trustScore: result.trustScore,
      scoreBreakdown: result.scoreBreakdown,
      matrix: result.matrix,
      signalCount: result.signals.length,
      fabricatedDropped: result.fabricatedDropped,
      usedFallback: result.usedFallback,
      errors: result.errors,

      // Debug payload — requirements sent to LLM + raw LLM output per source
      debugPayload: {
        requirementsSent: requirements,
        debugLog: result.debugLog,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Consent not given
    if (message.includes("vetting consent")) {
      return NextResponse.json(
        {
          error: "Candidate has not given vetting consent",
          humanReviewNotice:
            "A candidate must give in-app consent before vetting begins.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json(
      {
        error: message,
        debugPayload: {
          requirementsSent: requirements,
          fatalError: message,
        },
      },
      { status: 500 }
    );
  }
}

