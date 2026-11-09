/**
 * lib/auth/guards.ts — server-component page guards.
 *
 * Every private-data page/layout calls one of these helpers FIRST, before any
 * database query or render. Mirrors the hardened app/api convention:
 * session-first role resolution (getSessionFromCookie, then the signed demo
 * role cookie via getRoleFromCookie), DB-resolved ownership (never client
 * company IDs), and no trust in X-ConsultAI-Role / body role fields.
 *
 * - Live mode: unauthenticated -> redirect("/login"); wrong role -> redirect
 *   to the caller's role home; cross-company project access -> notFound()
 *   (non-disclosing, pages are reads). Company sessions are scoped to their
 *   own companyId with NO company-1 bypass. Freelancer sessions are scoped
 *   to candidates matching their session email/githubHandle.
 * - Demo mode (DEMO_MODE=true): enforcement bypassed so the role-switcher
 *   walkthrough and Playwright demo smoke tests keep working. Demo pages
 *   serve fictional in-memory fixtures only and never touch live data
 *   (demo/live isolation), so the bypass cannot leak real records.
 *
 * Session-less role-cookie holders (demo switcher, dev) keep unscoped
 * reads ONLY where a caller explicitly allows it: demo mode (fictional
 * fixtures), admin-global views, and legacy company page reads. Freelancer
 * assignment resolution is fail-closed for session-less callers (zero
 * assignments), and the freelancer pages plus creator-bound write routes
 * require a verified session in live mode. In production-live the role
 * cookie is only minted at login alongside the session cookie.
 */

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { candidates, projects } from "@/lib/db/schema";
import { getSessionFromCookie, type SessionInfo } from "./session";
import { getRoleFromCookie, type Role } from "./role-cookie";
import { isDemoMode } from "@/lib/demo/config";

export interface PageAuth {
  session: SessionInfo | null;
  role: Role | null;
  /** True in offline demo mode: fixtures only, enforcement bypassed. */
  demoBypass: boolean;
}

/** Landing page for each role; used for wrong-role redirects (no data leak). */
export function roleHome(role: Role): string {
  switch (role) {
    case "company":
      return "/dashboard";
    case "freelancer":
      return "/freelancer";
    case "admin":
      return "/admin";
  }
}

export function isRoleAllowed(
  role: Role | null,
  allowed: readonly Role[]
): boolean {
  return role !== null && allowed.includes(role);
}

/** Resolve the caller's session + role from request cookies. Never throws. */
export async function getPageAuth(): Promise<PageAuth> {
  const cookieStore = await cookies();
  const cookieHeader =
    cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ") || null;
  const session = await getSessionFromCookie(cookieHeader);
  const role = session?.role ?? (await getRoleFromCookie(cookieHeader));
  return { session, role, demoBypass: isDemoMode() };
}

/**
 * Require one of `allowed` roles before querying/rendering.
 * Demo mode returns immediately (fictional fixtures only).
 */
export async function requirePageRole(
  allowed: readonly Role[]
): Promise<PageAuth> {
  const auth = await getPageAuth();
  if (auth.demoBypass) return auth;
  if (!auth.role) redirect("/login");
  // Live mode: company pages require a verified company session carrying
  // companyId. A session-less role cookie alone would render unscoped
  // (cross-company) reads — the page equivalent of the D.3 API bypass.
  if (
    auth.role === "company" &&
    (auth.session?.role !== "company" || !auth.session.companyId)
  ) {
    redirect("/login");
  }
  if (!allowed.includes(auth.role)) redirect(roleHome(auth.role));
  return auth;
}

/**
 * Company scope for session-authenticated company callers.
 * Returns null for admin / session-less role cookies (unscoped by design).
 * The company-1 bypass is demo-only so the seeded demo login still sees
 * fixtures; live mode has no bypass.
 */
export function scopedCompanyId(auth: PageAuth): string | null {
  if (auth.session?.role !== "company" || !auth.session.companyId) return null;
  if (auth.demoBypass && auth.session.companyId === "company-1") return null;
  return auth.session.companyId;
}

/**
 * Role gate + project ownership check for /project/[id]/* routes.
 * Cross-company access (company session) and missing projects -> notFound().
 * A database outage resolves to "allow, let the page render its degraded
 * banner" — the page's own queries fail safely with no rows shown.
 */
export async function requireProjectAccess(
  projectId: string,
  allowed: readonly Role[] = ["company", "admin"]
): Promise<PageAuth> {
  const auth = await requirePageRole(allowed);
  if (auth.demoBypass) return auth;
  const scope = scopedCompanyId(auth);
  if (!scope) return auth;
  let companyId: string | null = null;
  try {
    const [row] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) notFound();
    companyId = row.companyId;
  } catch (err) {
    if (isNotFoundError(err)) throw err;
    return auth; // DB down: page renders its degraded banner, no rows leak.
  }
  if (companyId !== scope) notFound();
  return auth;
}

/**
 * Candidate IDs assigned to a freelancer session (by session email and/or
 * githubHandle, optionally within one project).
 * Returns null when unrestricted (demo, admin, authenticated non-freelancer
 * sessions). Returns [] for session-less callers (no verified identity —
 * fail closed, never unscoped) and when the session has no identity or no
 * assignments.
 */
export async function candidateIdsForFreelancer(
  auth: PageAuth,
  projectId?: string
): Promise<string[] | null> {
  if (auth.demoBypass) return null;
  if (auth.role === "admin") return null;
  if (auth.session?.role !== "freelancer") {
    // Authenticated non-freelancer sessions keep the legacy null; session-less
    // callers resolve to zero assignments instead of unrestricted reads.
    return auth.session ? null : [];
  }
  const email = auth.session.email?.trim().toLowerCase() || null;
  const githubHandle = auth.session.githubHandle?.trim() || null;
  if (!email && !githubHandle) return [];
  const rows = await db
    .select({
      id: candidates.id,
      email: candidates.email,
      githubHandle: candidates.githubHandle,
      projectId: candidates.projectId,
    })
    .from(candidates)
    .where(projectId ? eq(candidates.projectId, projectId) : undefined);
  return rows
    .filter(
      (c) =>
        (email && c.email.trim().toLowerCase() === email) ||
        (githubHandle &&
          (c.githubHandle ?? "").trim().toLowerCase() ===
            githubHandle.toLowerCase())
    )
    .map((c) => c.id);
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_NOT_FOUND")
  );
}
