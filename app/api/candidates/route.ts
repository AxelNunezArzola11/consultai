/**
 * POST /api/candidates
 *
 * Creates a new candidate for a project, then immediately records consent
 * and kicks off the vetting pipeline.
 *
 * Body:
 *   {
 *     projectId:    string  — must belong to the company
 *     githubHandle: string  — GitHub username (required; drives the analysis)
 *     name?:        string  — display name (defaults to "@githubHandle")
 *     email?:       string  — contact email (defaults to placeholder)
 *   }
 *
 * Returns: the created candidate id so the client can call the vetting route.
 *
 * Auth: company role cookie required.
 * Validation: Zod.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, ilike } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { candidates, projects } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { companySessionAllowsLiveAccess, getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { isDemoMode } from "@/lib/demo/config";
import {
  normalizeGithubHandle,
  isValidGithubHandle,
} from "@/lib/vetting/github-handle";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  projectId: z.string().min(1).max(100),
  githubHandle: z
    .string()
    .min(1)
    .max(200)
    .transform((val) => normalizeGithubHandle(val))
    .refine((val) => isValidGithubHandle(val), {
      message: "Invalid GitHub handle or URL",
    }),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden: company role required" }, { status: 403 });
  }

  // Live mode: company callers need a verified session (D.3 — a bare role
  // cookie must never authorize company access).
  if (!companySessionAllowsLiveAccess(role, session)) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("candidate-create", ip, 30, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { projectId, githubHandle, name, email } = parsed.data;

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    const project = t.projects.find((p) => p.id === projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (session?.role === "company" && session.companyId &&
        project.companyId !== session.companyId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const existing = t.candidates.find(
      (c) =>
        c.projectId === projectId &&
        (c.githubHandle ?? "").toLowerCase() === githubHandle.toLowerCase()
    );
    if (existing) {
      return NextResponse.json({
        id: existing.id,
        candidate: {
          id: existing.id,
          name: existing.name,
          email: existing.email,
          githubHandle: existing.githubHandle,
          status: existing.status,
          rank: existing.rank,
          trustScore: existing.trustScore ? Number(existing.trustScore) : null,
        },
        alreadyExists: true,
        simulated: true,
      });
    }
    const id = `demo-cand-${nanoid(8)}`;
    const now = new Date();
    const newRow = {
      id,
      projectId,
      name: name ?? `@${githubHandle}`,
      email: email ?? `${githubHandle}@github.placeholder`,
      githubHandle,
      portfolioUrl: null,
      trustScore: null,
      canDo: null,
      cannotDo: null,
      vettingSummary: null,
      vettingDiagnostics: null,
      rank: t.candidates.filter((c) => c.projectId === projectId).length + 1,
      status: "pending" as const,
      rejectionReason: null,
      vettingConsentAt: now,
      vettingRanAt: null,
      createdAt: now,
      updatedAt: now,
    };
    t.candidates.push(newRow);
    try {
      revalidatePath(`/project/${projectId}/vetting`);
      revalidatePath(`/project/${projectId}/candidates`);
      revalidatePath("/operations");
    } catch {
      // revalidatePath may no-op in unit tests outside Next request context
    }
    return NextResponse.json(
      {
        id,
        candidate: {
          id: newRow.id,
          name: newRow.name,
          email: newRow.email,
          githubHandle: newRow.githubHandle,
          status: newRow.status,
          rank: newRow.rank,
          trustScore: null,
        },
        alreadyExists: false,
        simulated: true,
      },
      { status: 201 }
    );
  }

  // Verify project exists
  const [project] = await db
    .select({ id: projects.id, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (session?.role === "company" && session.companyId &&
      project.companyId !== session.companyId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Check for duplicate github handle in THIS project (case-insensitive)
  const [existing] = await db
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.projectId, projectId),
        ilike(candidates.githubHandle, githubHandle)
      )
    )
    .limit(1);

  if (existing) {
    // Return the existing candidate so the client can proceed to vetting without a duplicate
    return NextResponse.json({
      id: existing.id,
      candidate: {
        id: existing.id,
        name: existing.name,
        email: existing.email,
        githubHandle: existing.githubHandle,
        status: existing.status,
        rank: existing.rank,
        trustScore: existing.trustScore ? Number(existing.trustScore) : null,
      },
      alreadyExists: true,
    });
  }

  const id = nanoid();
  const displayName  = name  ?? `@${githubHandle}`;
  const displayEmail = email ?? `${githubHandle}@github.placeholder`;

  await db.insert(candidates).values({
    id,
    projectId,
    name:         displayName,
    email:        displayEmail,
    githubHandle,
    status:       "pending",
    vettingConsentAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    revalidatePath(`/project/${projectId}/vetting`);
    revalidatePath(`/project/${projectId}/candidates`);
    revalidatePath("/operations");
  } catch {
    // revalidatePath may no-op in unit tests outside Next request context
  }

  return NextResponse.json(
    {
      id,
      candidate: {
        id,
        name: displayName,
        email: displayEmail,
        githubHandle,
        status: "pending",
        rank: null,
        trustScore: null,
      },
      alreadyExists: false,
    },
    { status: 201 }
  );
}
