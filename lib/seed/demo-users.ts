/**
 * Demo account provisioning for live (production) deployments.
 *
 * The login page offers "Fill Demo Company Login" / "Fill Demo Freelancer
 * Login" quick-fill buttons. In demo/dev/test environments those accounts
 * exist as in-memory seeds (`ensureSeededDemoUsers`). Production live
 * instances deliberately never auto-seed, so the two accounts must be
 * provisioned as real `users` rows — otherwise the quick-fill credentials
 * fail with `invalid_credentials`.
 *
 * This module is the single source of truth for the provisioned rows. It is
 * used by both entry points:
 *   - POST /api/admin/provision-demo-users (secret-gated, one-shot)
 *   - `npm run provision:demo-users` (local CLI against DATABASE_URL)
 *
 * Idempotent: existing rows (matched by email) are never overwritten —
 * they are reported as `skipped`. Passwords match the in-memory seeds and
 * the login page exactly.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";

export const DEMO_COMPANY_EMAIL = "founder@acme-demo.consultai.local";
export const DEMO_COMPANY_PASSWORD = "DemoCompany2026!";
export const DEMO_FREELANCER_EMAIL = "alex.rivera@freelancer-demo.consultai.local";
export const DEMO_FREELANCER_PASSWORD = "DemoFreelancer2026!";

export const DEMO_COMPANY_ID = "company-1";
export const DEMO_COMPANY_USER_ID = "user-demo-company-1";
export const DEMO_FREELANCER_USER_ID = "user-demo-freelancer-1";

export interface DemoProvisionResult {
  email: string;
  status: "created" | "skipped_exists";
}

export interface ProvisionDemoUsersResult {
  users: DemoProvisionResult[];
}

/**
 * Insert the two demo accounts (and their company row) when absent.
 * Never overwrites an existing row with the same email.
 */
export async function provisionDemoUsers(): Promise<ProvisionDemoUsersResult> {
  await db
    .insert(companies)
    .values({
      id: DEMO_COMPANY_ID,
      name: "Acme Corp (Demo)",
      email: DEMO_COMPANY_EMAIL,
      paypalMerchantId: null,
    })
    .onConflictDoNothing();

  const now = new Date();
  const specs = [
    {
      id: DEMO_COMPANY_USER_ID,
      email: DEMO_COMPANY_EMAIL,
      name: "Elena Vance",
      password: DEMO_COMPANY_PASSWORD,
      role: "company" as const,
      companyId: DEMO_COMPANY_ID,
      title: "VP of Engineering",
      githubHandle: null as string | null,
      portfolioUrl: null as string | null,
      skills: [] as string[],
      bio: null as string | null,
      hourlyRateUsd: null as string | null,
      availability: null as string | null,
    },
    {
      id: DEMO_FREELANCER_USER_ID,
      email: DEMO_FREELANCER_EMAIL,
      name: "Alex Rivera",
      password: DEMO_FREELANCER_PASSWORD,
      role: "freelancer" as const,
      companyId: null as string | null,
      title: "Principal Full-Stack & AI Engineer",
      githubHandle: "alexrivera-dev",
      portfolioUrl: "https://github.com/alexrivera-dev",
      skills: ["TypeScript", "Next.js", "Python", "FastAPI", "PostgreSQL"],
      bio: "Staff-level product and AI engineer specializing in financial workflows and multi-agent architectures.",
      hourlyRateUsd: "145.00",
      availability: "available",
    },
  ];

  const results: DemoProvisionResult[] = [];
  for (const spec of specs) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, spec.email))
      .limit(1);
    if (existing.length > 0) {
      results.push({ email: spec.email, status: "skipped_exists" });
      continue;
    }
    const passwordHash = await hashPassword(spec.password);
    try {
      await db
        .insert(users)
        .values({
          id: spec.id,
          email: spec.email,
          name: spec.name,
          passwordHash,
          role: spec.role,
          companyId: spec.companyId,
          title: spec.title,
          githubHandle: spec.githubHandle,
          portfolioUrl: spec.portfolioUrl,
          skills: spec.skills,
          bio: spec.bio,
          hourlyRateUsd: spec.hourlyRateUsd,
          availability: spec.availability,
          termsAcceptedAt: now,
        })
        .onConflictDoNothing();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.toLowerCase().includes("unique") || msg.includes("23505")) {
        results.push({ email: spec.email, status: "skipped_exists" });
        continue;
      }
      throw err;
    }
    results.push({ email: spec.email, status: "created" });
  }

  return { users: results };
}
