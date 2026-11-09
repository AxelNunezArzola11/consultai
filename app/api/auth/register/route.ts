/**
 * POST /api/auth/register
 *
 * Secure registration endpoint for Company and Freelancer accounts.
 * - Rejects self-registration for `admin` accounts.
 * - Validates password strength and hashes with `crypto.scrypt`.
 * - Enforces email uniqueness (`409 email_already_registered`).
 * - Normalizes GitHub username (`normalizeGithubHandle`) for freelancers.
 * - Creates company + owner account or freelancer account + profile.
 * - Issues the signed HttpOnly session cookie (`consultai_session_v1`) only
 *   (the role cookie is minted exclusively by /api/auth/set-role).
 */

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import {
  authServiceErrorCode,
  checkRateLimit,
  createSessionCookie,
  DatabaseUnavailableError,
  findUserByEmail,
  isStrictSessionPersistence,
  logAuthServiceFailure,
  normalizeEmail,
  registerUserAccount,
  verifyCsrfOrigin,
} from "@/lib/auth/session";
import { normalizeGithubHandle } from "@/lib/vetting/github-handle";
import { isDemoMode } from "@/lib/demo/config";

export const dynamic = "force-dynamic";

const CompanyRegisterSchema = z.object({
  accountType: z.literal("company"),
  companyName: z.string().trim().min(2, "Company name is required").max(120),
  industry: z.string().trim().max(100).optional(),
  companyWebsite: z.string().trim().max(255).optional(),
  companySize: z.string().trim().max(60).optional(),
  contactName: z.string().trim().min(2, "Contact name is required").max(120),
  contactRole: z.string().trim().max(100).optional(),
  email: z.string().trim().email("A valid work email is required").max(255),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128).optional(),
  billingCountry: z.string().trim().max(80).optional(),
  termsAccepted: z.boolean().refine((v) => v === true, {
    message: "You must accept the Terms of Service and Privacy Policy.",
  }),
});

const FreelancerRegisterSchema = z.object({
  accountType: z.literal("freelancer"),
  fullName: z.string().trim().min(2, "Full name is required").max(120),
  email: z.string().trim().email("A valid email is required").max(255),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128).optional(),
  specialty: z.string().trim().min(2, "Primary role/specialty is required").max(120),
  skills: z
    .union([z.array(z.string().trim()), z.string()])
    .optional()
    .transform((val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val.map((s) => s.trim()).filter(Boolean);
      return val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }),
  githubUsername: z.string().trim().max(200).optional(),
  portfolioUrl: z.string().trim().max(255).optional(),
  hourlyRateUsd: z.union([z.string(), z.number()]).optional(),
  availability: z.string().trim().max(60).optional(),
  bio: z.string().trim().max(2000).optional(),
  termsAccepted: z.boolean().refine((v) => v === true, {
    message: "You must accept the Terms of Service and Privacy Policy.",
  }),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Correlation id for 503 diagnostics (safe to return: random, no PII).
  const requestId = randomUUID();
  if (!verifyCsrfOrigin(req)) {
    return NextResponse.json(
      {
        error: "csrf_origin_mismatch",
        message: "Cross-origin registration requests are not permitted.",
      },
      { status: 403 }
    );
  }

  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  const rl = checkRateLimit(`register:${clientIp}`, 15, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `Too many registration requests. Please try again in ${rl.retryAfterSec} seconds.`,
        retryAfterSec: rl.retryAfterSec,
      },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const accountType = body.accountType;
  if (accountType === "admin") {
    return NextResponse.json(
      {
        error: "forbidden_role_escalation",
        message: "Admin accounts cannot be self-registered.",
      },
      { status: 403 }
    );
  }

  if (accountType !== "company" && accountType !== "freelancer") {
    return NextResponse.json(
      {
        error: "invalid_account_type",
        message: "accountType must be 'company' or 'freelancer'.",
      },
      { status: 400 }
    );
  }

  const rawPassword = typeof body.password === "string" ? body.password : "";
  const confirmPassword =
    typeof body.confirmPassword === "string" ? body.confirmPassword : undefined;

  if (confirmPassword !== undefined && rawPassword !== confirmPassword) {
    return NextResponse.json(
      {
        error: "password_mismatch",
        message: "Password and confirmation password do not match.",
      },
      { status: 400 }
    );
  }

  const pwCheck = validatePasswordStrength(rawPassword);
  if (!pwCheck.valid) {
    return NextResponse.json(
      {
        error: "weak_password",
        message: pwCheck.errors[0],
        details: pwCheck.errors,
      },
      { status: 400 }
    );
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  if (rawEmail) {
    let existing: Awaited<ReturnType<typeof findUserByEmail>>;
    try {
      existing = await findUserByEmail(rawEmail);
    } catch (err) {
      // Uniqueness cannot be verified without the user lookup — fail
      // closed instead of registering a possible duplicate.
      const dbCode =
        err instanceof DatabaseUnavailableError ? err.dbCode : null;
      logAuthServiceFailure("register", requestId, "user_lookup_failed", dbCode);
      const error = authServiceErrorCode(dbCode);
      return NextResponse.json(
        {
          error,
          message:
            error === "auth_service_misconfigured"
              ? "Registration is not available on this deployment yet (server setup incomplete)."
              : "Registration is temporarily unavailable. Please try again in a moment.",
          requestId,
        },
        { status: 503 }
      );
    }
    if (existing) {
      return NextResponse.json(
        {
          error: "email_already_registered",
          message: "An account with this email address already exists.",
        },
        { status: 409 }
      );
    }
  }

  const passwordHash = await hashPassword(rawPassword);
  const nowIso = new Date().toISOString();

  if (accountType === "company") {
    const parsed = CompanyRegisterSchema.safeParse(body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return NextResponse.json(
        {
          error: "validation_error",
          message: firstIssue?.message ?? "Invalid company registration data.",
          issues: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    const d = parsed.data;
    const companyId = `company-${randomUUID().slice(0, 8)}`;

    if (isDemoMode()) {
      try {
        const { getDemoTables } = await import("@/lib/demo/store");
        const t = getDemoTables();
        t.companies.push({
          id: companyId,
          name: d.companyName,
          email: normalizeEmail(d.email),
          paypalMerchantId: null,
          createdAt: new Date(),
        });
      } catch {
        // Ignore if demo store unavailable
      }
    }

    const regResult = await registerUserAccount({
      email: d.email,
      name: d.contactName,
      passwordHash,
      role: "company",
      companyId,
      companyName: d.companyName,
      industry: d.industry ?? null,
      companyWebsite: d.companyWebsite ?? null,
      companySize: d.companySize ?? null,
      billingCountry: d.billingCountry ?? null,
      title: d.contactRole ?? "Company Owner",
      githubHandle: null,
      portfolioUrl: null,
      skills: [],
      bio: null,
      hourlyRateUsd: null,
      availability: null,
      termsAcceptedAt: nowIso,
    });

    if (regResult.error || !regResult.user) {
      return NextResponse.json(
        {
          error: "email_already_registered",
          message: "An account with this email address already exists.",
        },
        { status: 409 }
      );
    }

    const { sessionCookie, session, dbPersisted, dbErrorCode } =
      await createSessionCookie(regResult.user);
    if (isStrictSessionPersistence() && !dbPersisted) {
      logAuthServiceFailure(
        "register",
        requestId,
        "session_persist_failed",
        dbErrorCode
      );
      const error = authServiceErrorCode(dbErrorCode);
      return NextResponse.json(
        {
          error,
          message:
            error === "auth_service_misconfigured"
              ? "Registration is not available on this deployment yet (server setup incomplete)."
              : "Registration is temporarily unavailable. Please try again in a moment.",
          requestId,
        },
        { status: 503 }
      );
    }
    // Session cookie only (D.3): never mint a role cookie alongside it.

    const res = NextResponse.json(
      {
        ok: true,
        user: {
          id: session.userId,
          email: session.email,
          name: session.name,
          role: session.role,
          companyId: session.companyId,
          companyName: session.companyName,
        },
        redirectTo: "/dashboard",
      },
      { status: 201 }
    );
    res.headers.append("Set-Cookie", sessionCookie);
    return res;
  }

  // Freelancer registration
  const parsed = FreelancerRegisterSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: "validation_error",
        message: firstIssue?.message ?? "Invalid freelancer registration data.",
        issues: parsed.error.issues,
      },
      { status: 400 }
    );
  }

  const d = parsed.data;
  const normalizedHandle = d.githubUsername
    ? normalizeGithubHandle(d.githubUsername) || null
    : null;

  const regResult = await registerUserAccount({
    email: d.email,
    name: d.fullName,
    passwordHash,
    role: "freelancer",
    companyId: null,
    companyName: null,
    industry: null,
    companyWebsite: null,
    companySize: null,
    billingCountry: null,
    title: d.specialty,
    githubHandle: normalizedHandle,
    portfolioUrl: d.portfolioUrl ?? null,
    skills: d.skills,
    bio: d.bio ?? null,
    hourlyRateUsd:
      d.hourlyRateUsd !== undefined && d.hourlyRateUsd !== ""
        ? String(d.hourlyRateUsd)
        : null,
    availability: d.availability ?? "available",
    termsAcceptedAt: nowIso,
  });

  if (regResult.error || !regResult.user) {
    return NextResponse.json(
      {
        error: "email_already_registered",
        message: "An account with this email address already exists.",
      },
      { status: 409 }
    );
  }

  const { sessionCookie, session, dbPersisted, dbErrorCode } =
    await createSessionCookie(regResult.user);
  if (isStrictSessionPersistence() && !dbPersisted) {
    logAuthServiceFailure(
      "register",
      requestId,
      "session_persist_failed",
      dbErrorCode
    );
    const error = authServiceErrorCode(dbErrorCode);
    return NextResponse.json(
      {
        error,
        message:
          error === "auth_service_misconfigured"
            ? "Registration is not available on this deployment yet (server setup incomplete)."
            : "Registration is temporarily unavailable. Please try again in a moment.",
        requestId,
      },
      { status: 503 }
    );
  }
  // Session cookie only (D.3): never mint a role cookie alongside it.

  const res = NextResponse.json(
    {
      ok: true,
      user: {
        id: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
        githubHandle: session.githubHandle,
      },
      redirectTo: "/freelancer",
    },
    { status: 201 }
  );
  res.headers.append("Set-Cookie", sessionCookie);
  return res;
}
