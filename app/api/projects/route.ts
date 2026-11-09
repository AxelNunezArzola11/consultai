/**
 * POST /api/projects
 *
 * Creates a draft project row. Called ONLY from explicit user action (the
 * /project/new start form) — never on page load.
 *
 * Body: { projectId: string (client-generated nanoid), title?: string, brief?: string }
 * Returns: { projectId, created: boolean }
 *
 * Idempotency: the client generates the project ID once per form instance, so
 * retries and double-submits resolve to the same row (onConflictDoNothing).
 *
 * Server-side authorization: company or admin role only.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import { getRoleFromCookie, getCompanyIdFromCookie } from "@/lib/auth/role-cookie";
import { getSessionFromCookie } from "@/lib/auth/session";
import { checkRateLimit, getIp } from "@/lib/auth/rate-limit";
import { writeAuditLog } from "@/lib/db/audit";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: listing company projects requires the company or admin role." },
      { status: 403 }
    );
  }

  const companyId = await getCompanyIdFromCookie(cookieHeader);

  if (role === "company") {
    // Own company only, always. Session-less company holders have no
    // company context and are rejected — never the full list.
    if (!companyId) {
      return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
    }
    if (isDemoMode()) {
      const { getDemoTables } = await import("@/lib/demo/store");
      const t = getDemoTables();
      return NextResponse.json({
        projects: t.projects.filter((p) => p.companyId === companyId),
        simulated: true,
      });
    }
    const list = await db
      .select()
      .from(projects)
      .where(eq(projects.companyId, companyId));
    return NextResponse.json({ projects: list });
  }

  // Admin: explicit global-list capability (not a company bypass).
  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    return NextResponse.json({
      projects: getDemoTables().projects,
      simulated: true,
    });
  }
  return NextResponse.json({ projects: await db.select().from(projects) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cookieHeader = req.headers.get("cookie") ?? null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  if (role !== "company" && role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: creating projects requires the company or admin role." },
      { status: 403 }
    );
  }

  const ip = getIp(req);
  const { ok, retryAfterSec } = checkRateLimit("project-create", ip, 20, 60);
  if (!ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  let body: { projectId?: string; title?: string; brief?: string; companyId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const projectId = body.projectId?.trim() ?? "";
  if (!projectId || projectId.length > 64) {
    return NextResponse.json(
      { error: "projectId (client-generated, max 64 chars) is required" },
      { status: 400 }
    );
  }
  const title = (body.title?.trim() || "New project").slice(0, 200);
  const brief = body.brief?.trim().slice(0, 20000) || null;
  const sessionCompanyId = await getCompanyIdFromCookie(req.headers.get("cookie"));

  // Resolve the owning company with no silent defaults. Company role:
  // verified session company only (a client-supplied companyId is never
  // trusted); in live mode a missing company context is rejected. Admin:
  // explicit body companyId validated against existing companies.
  if (role === "company" && !sessionCompanyId && !isDemoMode()) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }
  let adminCompanyId: string | null = null;
  if (role === "admin") {
    const requested =
      typeof body.companyId === "string" ? body.companyId.trim() : "";
    if (!requested || requested.length > 64) {
      return NextResponse.json(
        { error: "companyId (existing company) is required" },
        { status: 400 }
      );
    }
    const exists = isDemoMode()
      ? (await import("@/lib/demo/store"))
          .getDemoTables()
          .companies.some((c) => c.id === requested)
      : (
          await db
            .select({ id: companies.id })
            .from(companies)
            .where(eq(companies.id, requested))
            .limit(1)
        ).length > 0;
    if (!exists) {
      return NextResponse.json({ error: "unknown_company" }, { status: 404 });
    }
    adminCompanyId = requested;
  }

  if (isDemoMode()) {
    const { getDemoTables } = await import("@/lib/demo/store");
    const t = getDemoTables();
    // Demo session-less company creates land in the fictional first demo
    // company (TechNova fixtures parity for the role-switcher walkthrough;
    // demo/live isolation holds — never live data).
    const companyId =
      adminCompanyId ??
      sessionCompanyId ??
      t.companies[0]?.id ??
      "demo-company-technova";
    const existing = t.projects.find((p) => p.id === projectId);
    if (existing) {
      if (role !== "admin" && existing.companyId !== companyId) {
        return NextResponse.json(
          { error: "Forbidden: project belongs to another company." },
          { status: 403 }
        );
      }
      return NextResponse.json({ projectId, created: false, simulated: true });
    }
    const now = new Date();
    t.projects.push({
      id: projectId,
      companyId,
      title,
      rawBrief: brief,
      structuredBrief: null,
      structuredPlan: null,
      sanitizedSummary: null,
      githubRepoUrl: null,
      acceptanceCriteria: null,
      status: "draft",
      autoApproveThresholdUsd: "500.00",
      createdAt: now,
      updatedAt: now,
    });
    await writeAuditLog({
      entityType: "project",
      entityId: projectId,
      event: "PROJECT_CREATED",
      actor: session ? `${session.role}:${session.userId}` : `${role}-operator`,
      payload: { title },
    });
    try {
      revalidatePath("/dashboard");
      revalidatePath("/planning");
      revalidatePath("/operations");
    } catch {
      // revalidatePath may no-op in unit tests outside Next request context
    }
    return NextResponse.json(
      { projectId, created: true, simulated: true },
      { status: 201 }
    );
  }

  // Live branch: session company for company role, explicit validated
  // company for admin. No company-1 (or any other) silent default.
  const companyId = adminCompanyId ?? sessionCompanyId;
  if (!companyId) {
    return NextResponse.json({ error: "missing_company_context" }, { status: 403 });
  }

  const [existing] = await db
    .select({ id: projects.id, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (existing) {
    // Idempotent replay — no duplicate row. Ownership is always enforced
    // for company role (no session bypass for cross-company replays).
    if (role !== "admin" && existing.companyId !== companyId) {
      return NextResponse.json(
        { error: "Forbidden: project belongs to another company." },
        { status: 403 }
      );
    }
    return NextResponse.json({ projectId, created: false });
  }

  await db
    .insert(projects)
    .values({
      id: projectId,
      companyId,
      title,
      rawBrief: brief,
      status: "draft",
    })
    .onConflictDoNothing();

  await writeAuditLog({
    entityType: "project",
    entityId: projectId,
    event: "PROJECT_CREATED",
    actor: session ? `${session.role}:${session.userId}` : `${role}-operator`,
    payload: { title },
  });

  try {
    revalidatePath("/dashboard");
    revalidatePath("/planning");
    revalidatePath("/operations");
  } catch {
    // revalidatePath may no-op in unit tests outside Next request context
  }

  return NextResponse.json({ projectId, created: true }, { status: 201 });
}
