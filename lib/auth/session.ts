/**
 * lib/auth/session.ts
 *
 * Secure user account store, brute-force protection, rate limiting, CSRF origin
 * verification, and signed HttpOnly session management for ConsultAI.
 *
 * Cookie: consultai_session_v1
 * - HttpOnly; SameSite=Lax; Path=/; Secure (in production)
 * - Contains a signed HS256 JWT with `jti` (sessionId), `sub` (userId),
 *   `email`, `name`, `role`, `companyId`, and `githubHandle`.
 * - Server-side revocation checks both the in-memory revocation set and, when
 *   not in DEMO_MODE and `DATABASE_URL` is configured, the PostgreSQL
 *   `auth_sessions` table (`authSessions.revokedAt`) for multi-instance
 *   serverless revocation.
 * - Strict persistence (`isStrictSessionPersistence`, default in production
 *   live mode): migration 0010 (`users` + `auth_sessions` tables) is a hard
 *   production prerequisite. Login/register return 503 when the session row
 *   cannot be persisted, and validation rejects tokens whose row is missing
 *   or unreadable — sessions never validate by signature alone in strict
 *   mode. Demo, development, and test environments keep the degraded
 *   JWT + in-memory path. Strict mode can be opted out with
 *   `LIVE_REQUIRE_DB_SESSION=false` (not recommended).
 */

import { createHash, randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import type { Role } from "./role-cookie";
import { hashPassword, verifyPassword } from "./password";
import { isDemoMode } from "@/lib/demo/config";

export const SESSION_COOKIE_NAME = "consultai_session_v1";
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

export interface AuthUserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
  companyId: string | null;
  companyName: string | null;
  industry: string | null;
  companyWebsite: string | null;
  companySize: string | null;
  billingCountry: string | null;
  title: string | null;
  githubHandle: string | null;
  portfolioUrl: string | null;
  skills: string[];
  bio: string | null;
  hourlyRateUsd: string | null;
  availability: string | null;
  termsAcceptedAt: string;
  createdAt: string;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  companyId: string | null;
  companyName: string | null;
  githubHandle: string | null;
  isAuthenticatedUser: boolean;
}

interface GlobalAuthStore {
  usersByEmail: Map<string, AuthUserRecord>;
  usersById: Map<string, AuthUserRecord>;
  revokedSessions: Set<string>;
  activeSessions: Map<string, SessionInfo & { expiresAtMs: number }>;
  failedLogins: Map<string, { count: number; lockedUntilMs: number }>;
  rateLimits: Map<string, { count: number; resetAtMs: number }>;
  seeded: boolean;
}

function getAuthStore(): GlobalAuthStore {
  const g = globalThis as unknown as { __consultaiAuthStore?: GlobalAuthStore };
  if (!g.__consultaiAuthStore) {
    g.__consultaiAuthStore = {
      usersByEmail: new Map(),
      usersById: new Map(),
      revokedSessions: new Map ? new Set() : new Set(),
      activeSessions: new Map(),
      failedLogins: new Map(),
      rateLimits: new Map(),
      seeded: false,
    };
  }
  return g.__consultaiAuthStore;
}

function shouldUseDatabaseAuth(): boolean {
  return !isDemoMode() && Boolean(process.env.DATABASE_URL);
}

/**
 * True when session persistence must be database-backed and fail closed:
 * production live mode unless explicitly opted out with
 * `LIVE_REQUIRE_DB_SESSION=false`.
 */
export function isStrictSessionPersistence(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    !isDemoMode() &&
    process.env.LIVE_REQUIRE_DB_SESSION !== "false"
  );
}

/**
 * Live-mode company session requirement (D.3 cookie-stripping defense).
 *
 * A company role cookie alone never authorizes company access outside demo
 * mode: otherwise stripping `consultai_session_v1` (or presenting a bare
 * role JWT) would silently drop every session-keyed ownership check and
 * expose other companies' rows. Admin keeps its explicit global contract
 * and non-company roles are unaffected (their own gates decide).
 *
 * Returns true when a company-role caller may proceed: demo mode
 * (fictional fixtures + role-switcher parity) or a verified company
 * session carrying companyId.
 */
export function companySessionAllowsLiveAccess(
  role: Role | null,
  session: SessionInfo | null
): boolean {
  if (role !== "company") return true;
  if (isDemoMode()) return true;
  return (
    session?.role === "company" &&
    typeof session.companyId === "string" &&
    session.companyId.length > 0
  );
}

let ephemeralSessionSecret: Uint8Array | null = null;

/**
 * Thrown when a user lookup attempted a database read and the read failed.
 * Callers must map this to 503 (service unavailable), never to 401: a
 * database outage must not disguise itself as "invalid credentials".
 * `dbCode` carries the driver error code (e.g. Postgres `42P01` for a
 * missing relation) for server-side logs only — never echo it to clients.
 */
export class DatabaseUnavailableError extends Error {
  readonly dbCode: string | null;
  constructor(dbCode: string | null = null) {
    super("database unavailable");
    this.name = "DatabaseUnavailableError";
    this.dbCode = dbCode;
  }
}

/**
 * Extracts a Postgres/Neon driver error code for server-side logging.
 * Walks the `cause` chain because drizzle-orm wraps driver failures
 * (the Neon `NeonDbError` with `code`, e.g. `42P01`, arrives as
 * `.cause` of drizzle's `Failed query: ...` error). Depth-bounded so a
 * cyclic cause can never hang the auth path.
 */
export function dbErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return null;
    if ("code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True when the driver reports a missing relation (migration not applied). */
export function isMissingRelationError(err: unknown): boolean {
  return dbErrorCode(err) === "42P01";
}

/**
 * Maps a persistence/lookup failure to the public 503 error code. A
 * missing relation (`42P01`) means the auth schema was never applied — a
 * permanent configuration state, not a transient outage — so callers
 * report `auth_service_misconfigured` and the UI can say so honestly.
 * Everything else stays `auth_unavailable` (transient/unknown).
 */
export function authServiceErrorCode(
  dbCode: string | null
): "auth_service_misconfigured" | "auth_unavailable" {
  return dbCode === "42P01"
    ? "auth_service_misconfigured"
    : "auth_unavailable";
}

/**
 * One-line server-side record for auth 503s. Carries only the failure
 * category, driver code, and request correlation id — never emails,
 * passwords, hashes, tokens, cookies, URLs, or secrets.
 */
export function logAuthServiceFailure(
  route: string,
  requestId: string,
  category: "user_lookup_failed" | "session_persist_failed",
  dbCode: string | null
): void {
  console.error(
    `[auth:${route}] requestId=${requestId} result=${category} dbCode=${dbCode ?? "none"}`
  );
}

let ephemeralSecretWarned = false;

function getSessionSecret(): Uint8Array {
  const secret =
    process.env.SESSION_COOKIE_SECRET || process.env.ROLE_COOKIE_SECRET;
  if (secret && secret.length >= 32) {
    return new TextEncoder().encode(secret);
  }
  // No usable secret: sessions are signed with a per-boot random key.
  // Harmless in demo/dev/test, but in production-live this breaks sessions
  // on every restart and diverges them across instances — warn loudly
  // (server log only; never the secret itself).
  if (
    !ephemeralSecretWarned &&
    process.env.NODE_ENV === "production" &&
    !isDemoMode()
  ) {
    ephemeralSecretWarned = true;
    console.error(
      "[auth] SESSION_COOKIE_SECRET/ROLE_COOKIE_SECRET missing or shorter " +
        "than 32 chars in production live mode — using an ephemeral per-boot " +
        "signing secret. Set a persistent secret immediately."
    );
  }
  if (!ephemeralSessionSecret) {
    ephemeralSessionSecret = new Uint8Array(32);
    crypto.getRandomValues(ephemeralSessionSecret);
  }
  return ephemeralSessionSecret;
}

/**
 * Ensures synthetic DEMO accounts exist so reviewers can test login out-of-the-box
 * without touching any production credentials.
 *
 * Production-live instances never auto-seed: demo access there requires
 * real provisioned `users` rows (see the provisioning runbook), so phantom
 * in-memory accounts can neither shadow provisioned rows nor bypass
 * revocation, and a missing row honestly reports invalid credentials
 * instead of failing session persistence later.
 */
export async function ensureSeededDemoUsers(): Promise<void> {
  if (process.env.NODE_ENV === "production" && !isDemoMode()) return;
  const store = getAuthStore();
  if (store.seeded) return;
  store.seeded = true;

  const now = new Date().toISOString();
  const demoCompanyHash = await hashPassword("DemoCompany2026!");
  const demoFreelancerHash = await hashPassword("DemoFreelancer2026!");

  const companyUser: AuthUserRecord = {
    id: "user-demo-company-1",
    email: "founder@acme-demo.consultai.local",
    name: "Elena Vance",
    passwordHash: demoCompanyHash,
    role: "company",
    companyId: "company-1",
    companyName: "Acme Corp (Demo)",
    industry: "Enterprise SaaS",
    companyWebsite: "https://acme.example.com",
    companySize: "51-200",
    billingCountry: "US",
    title: "VP of Engineering",
    githubHandle: null,
    portfolioUrl: null,
    skills: [],
    bio: null,
    hourlyRateUsd: null,
    availability: null,
    termsAcceptedAt: now,
    createdAt: now,
  };

  const freelancerUser: AuthUserRecord = {
    id: "user-demo-freelancer-1",
    email: "alex.rivera@freelancer-demo.consultai.local",
    name: "Alex Rivera",
    passwordHash: demoFreelancerHash,
    role: "freelancer",
    companyId: null,
    companyName: null,
    industry: null,
    companyWebsite: null,
    companySize: null,
    billingCountry: null,
    title: "Principal Full-Stack & AI Engineer",
    githubHandle: "alexrivera-dev",
    portfolioUrl: "https://github.com/alexrivera-dev",
    skills: ["TypeScript", "Next.js", "Python", "FastAPI", "PostgreSQL"],
    bio: "Staff-level product and AI engineer specializing in financial workflows and multi-agent architectures.",
    hourlyRateUsd: "145.00",
    availability: "available",
    termsAcceptedAt: now,
    createdAt: now,
  };

  if (!store.usersByEmail.has(companyUser.email)) {
    store.usersByEmail.set(companyUser.email, companyUser);
    store.usersById.set(companyUser.id, companyUser);
  }
  if (!store.usersByEmail.has(freelancerUser.email)) {
    store.usersByEmail.set(freelancerUser.email, freelancerUser);
    store.usersById.set(freelancerUser.id, freelancerUser);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(
  rawEmail: string
): Promise<AuthUserRecord | null> {
  await ensureSeededDemoUsers();
  const email = normalizeEmail(rawEmail);
  const store = getAuthStore();
  const cached = store.usersByEmail.get(email);
  if (cached) return cached;

  if (shouldUseDatabaseAuth()) {
    try {
      const { db } = await import("@/lib/db");
      const { users, companies } = await import("@/lib/db/schema");
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const row = rows[0];
      if (row) {
        let companyName: string | null = null;
        if (row.companyId) {
          const compRows = await db
            .select()
            .from(companies)
            .where(eq(companies.id, row.companyId))
            .limit(1);
          companyName = compRows[0]?.name ?? null;
        }
        const record: AuthUserRecord = {
          id: row.id,
          email: row.email,
          name: row.name,
          passwordHash: row.passwordHash,
          role: row.role,
          companyId: row.companyId ?? null,
          companyName,
          industry: null,
          companyWebsite: null,
          companySize: null,
          billingCountry: null,
          title: row.title ?? null,
          githubHandle: row.githubHandle ?? null,
          portfolioUrl: row.portfolioUrl ?? null,
          skills: Array.isArray(row.skills) ? (row.skills as string[]) : [],
          bio: row.bio ?? null,
          hourlyRateUsd: row.hourlyRateUsd ?? null,
          availability: row.availability ?? null,
          termsAcceptedAt:
            row.termsAcceptedAt?.toISOString() ?? new Date().toISOString(),
          createdAt: row.createdAt.toISOString(),
        };
        store.usersByEmail.set(email, record);
        store.usersById.set(record.id, record);
        return record;
      }
    } catch (err) {
      // The database was reachable enough to attempt but the read failed
      // (missing table, connection loss, ...). This must surface as a
      // service failure — returning null here would disguise it as
      // "invalid credentials". (When no database is configured at all,
      // shouldUseDatabaseAuth() is false and we return null below.)
      throw new DatabaseUnavailableError(dbErrorCode(err));
    }
  }

  return null;
}

export async function findUserById(
  userId: string
): Promise<AuthUserRecord | null> {
  await ensureSeededDemoUsers();
  const store = getAuthStore();
  const cached = store.usersById.get(userId);
  if (cached) return cached;

  if (shouldUseDatabaseAuth()) {
    try {
      const { db } = await import("@/lib/db");
      const { users, companies } = await import("@/lib/db/schema");
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const row = rows[0];
      if (row) {
        let companyName: string | null = null;
        if (row.companyId) {
          const compRows = await db
            .select()
            .from(companies)
            .where(eq(companies.id, row.companyId))
            .limit(1);
          companyName = compRows[0]?.name ?? null;
        }
        const record: AuthUserRecord = {
          id: row.id,
          email: row.email,
          name: row.name,
          passwordHash: row.passwordHash,
          role: row.role,
          companyId: row.companyId ?? null,
          companyName,
          industry: null,
          companyWebsite: null,
          companySize: null,
          billingCountry: null,
          title: row.title ?? null,
          githubHandle: row.githubHandle ?? null,
          portfolioUrl: row.portfolioUrl ?? null,
          skills: Array.isArray(row.skills) ? (row.skills as string[]) : [],
          bio: row.bio ?? null,
          hourlyRateUsd: row.hourlyRateUsd ?? null,
          availability: row.availability ?? null,
          termsAcceptedAt:
            row.termsAcceptedAt?.toISOString() ?? new Date().toISOString(),
          createdAt: row.createdAt.toISOString(),
        };
        store.usersByEmail.set(record.email, record);
        store.usersById.set(record.id, record);
        return record;
      }
    } catch {
      // Fall back to in-memory store if migration 0010 has not been applied yet
    }
  }

  return null;
}

export async function registerUserAccount(
  input: Omit<AuthUserRecord, "id" | "createdAt" | "email"> & {
    id?: string;
    email: string;
  }
): Promise<{ user?: AuthUserRecord; error?: string }> {
  await ensureSeededDemoUsers();
  const store = getAuthStore();
  const email = normalizeEmail(input.email);

  const existing = await findUserByEmail(email);
  if (existing) {
    return { error: "email_already_registered" };
  }

  const user: AuthUserRecord = {
    ...input,
    id: input.id ?? `user-${randomUUID()}`,
    email,
    createdAt: new Date().toISOString(),
  };

  if (shouldUseDatabaseAuth()) {
    try {
      const { db } = await import("@/lib/db");
      const { users, companies } = await import("@/lib/db/schema");
      if (user.role === "company" && user.companyId) {
        await db
          .insert(companies)
          .values({
            id: user.companyId,
            name: user.companyName ?? "Enterprise Company",
            email: user.email,
            paypalMerchantId: null,
          })
          .onConflictDoNothing();
      }
      await db.insert(users).values({
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        role: user.role,
        companyId: user.companyId,
        title: user.title,
        githubHandle: user.githubHandle,
        portfolioUrl: user.portfolioUrl,
        skills: user.skills,
        bio: user.bio,
        hourlyRateUsd: user.hourlyRateUsd,
        availability: user.availability,
        termsAcceptedAt: new Date(user.termsAcceptedAt),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.toLowerCase().includes("unique") || msg.includes("23505")) {
        return { error: "email_already_registered" };
      }
      // If table `users` is not yet migrated in the target DB, fall back to memory store
    }
  }

  store.usersByEmail.set(email, user);
  store.usersById.set(user.id, user);
  return { user };
}

/**
 * Sliding-window rate limiter for registration and login endpoints.
 */
export function checkRateLimit(
  key: string,
  maxRequests = 20,
  windowMs = 60_000
): { allowed: boolean; retryAfterSec: number } {
  const store = getAuthStore();
  const now = Date.now();
  const entry = store.rateLimits.get(key);
  if (!entry || entry.resetAtMs <= now) {
    store.rateLimits.set(key, { count: 1, resetAtMs: now + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (entry.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAtMs - now) / 1000)),
    };
  }
  entry.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Verifies CSRF protection on state-changing auth endpoints by comparing the
 * `Origin` header (when present) against the target `Host` / `X-Forwarded-Host`
 * or request URL host. Requests without an `Origin` header (e.g., same-origin
 * server/CLI/unit-test calls) are permitted.
 */
export function verifyCsrfOrigin(req: {
  headers: { get(name: string): string | null };
  url?: string;
}): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const headerHost = (
      req.headers.get("x-forwarded-host") ||
      req.headers.get("host") ||
      (req.url ? new URL(req.url).host : "")
    )
      .split(",")[0]
      .trim()
      .toLowerCase();
    if (!headerHost) return true;
    return originHost === headerHost;
  } catch {
    return false;
  }
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes

export function checkBruteForceLockout(emailOrIpKey: string): {
  locked: boolean;
  retryAfterSec: number;
} {
  const store = getAuthStore();
  const entry = store.failedLogins.get(emailOrIpKey);
  if (!entry) return { locked: false, retryAfterSec: 0 };

  const now = Date.now();
  if (entry.lockedUntilMs > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((entry.lockedUntilMs - now) / 1000),
    };
  }
  if (entry.lockedUntilMs > 0 && entry.lockedUntilMs <= now) {
    store.failedLogins.delete(emailOrIpKey);
  }
  return { locked: false, retryAfterSec: 0 };
}

export function recordFailedLogin(emailOrIpKey: string): void {
  const store = getAuthStore();
  const current = store.failedLogins.get(emailOrIpKey) ?? {
    count: 0,
    lockedUntilMs: 0,
  };
  const nextCount = current.count + 1;
  const lockedUntilMs =
    nextCount >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0;
  store.failedLogins.set(emailOrIpKey, { count: nextCount, lockedUntilMs });
}

export function clearFailedLogins(emailOrIpKey: string): void {
  getAuthStore().failedLogins.delete(emailOrIpKey);
}

/**
 * Authenticates a user by email and password.
 * Performs a dummy hash verification when the email does not exist to prevent
 * timing-based account enumeration.
 */
export async function authenticateUser(
  rawEmail: string,
  password: string
): Promise<{
  user?: AuthUserRecord;
  error?: "invalid_credentials" | "account_locked";
  retryAfterSec?: number;
}> {
  await ensureSeededDemoUsers();
  const email = normalizeEmail(rawEmail);
  const lockKey = `login:${email}`;
  const lockStatus = checkBruteForceLockout(lockKey);
  if (lockStatus.locked) {
    return {
      error: "account_locked",
      retryAfterSec: lockStatus.retryAfterSec,
    };
  }

  const user = await findUserByEmail(email);
  if (!user) {
    // Constant-time dummy check so non-existent emails take the same time as real ones
    const dummyHash =
      "scrypt$16384$8$1$00112233445566778899aabbccddeeff$" + "00".repeat(64);
    await verifyPassword(password, dummyHash);
    recordFailedLogin(lockKey);
    return { error: "invalid_credentials" };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    recordFailedLogin(lockKey);
    return { error: "invalid_credentials" };
  }

  clearFailedLogins(lockKey);
  return { user };
}

/**
 * Creates a signed session cookie for an authenticated user and records the session
 * in both memory and (when not in DEMO_MODE) the PostgreSQL `auth_sessions` table.
 *
 * `dbPersisted` reports whether the `auth_sessions` row was written. Strict
 * callers (login/register in production live mode) must fail closed (503)
 * when it is false instead of issuing a memory-only session.
 */
export async function createSessionCookie(user: AuthUserRecord): Promise<{
  sessionCookie: string;
  session: SessionInfo;
  tokenHash: string;
  dbPersisted: boolean;
  /**
   * Driver error code when persistence was attempted and failed
   * (e.g. `42P01` = missing relation). Server-side diagnostics only.
   */
  dbErrorCode: string | null;
}> {
  const sessionId = `sess-${randomUUID()}`;
  const session: SessionInfo = {
    sessionId,
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    companyId: user.companyId,
    companyName: user.companyName,
    githubHandle: user.githubHandle,
    isAuthenticatedUser: true,
  };

  const secret = getSessionSecret();
  const token = await new SignJWT({
    sub: user.id,
    jti: sessionId,
    email: user.email,
    name: user.name,
    role: user.role,
    companyId: user.companyId,
    companyName: user.companyName,
    githubHandle: user.githubHandle,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_S}s`)
    .sign(secret);

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAtMs = Date.now() + SESSION_MAX_AGE_S * 1000;
  const store = getAuthStore();
  store.activeSessions.set(sessionId, {
    ...session,
    expiresAtMs,
  });

  let dbPersisted = false;
  let persistErrorCode: string | null = null;
  if (shouldUseDatabaseAuth()) {
    try {
      const { db } = await import("@/lib/db");
      const { authSessions } = await import("@/lib/db/schema");
      await db.insert(authSessions).values({
        id: sessionId,
        userId: user.id,
        tokenHash,
        role: user.role,
        companyId: user.companyId,
        expiresAt: new Date(expiresAtMs),
      });
      dbPersisted = true;
    } catch (err) {
      // Graceful fallback if migration 0010 is not yet applied (demo/dev
      // only — strict production callers check dbPersisted and fail closed).
      // The code is captured so callers can log the failure category.
      persistErrorCode = dbErrorCode(err);
    }
  }

  const isProd = process.env.NODE_ENV === "production";
  const sessionCookie = [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Max-Age=${SESSION_MAX_AGE_S}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    ...(isProd ? ["Secure"] : []),
  ].join("; ");

  return { sessionCookie, session, tokenHash, dbPersisted, dbErrorCode: persistErrorCode };
}

/**
 * Parses and verifies `consultai_session_v1` from a Cookie header.
 * Checks expiration and server-side revocation (both in-memory and DB `auth_sessions`).
 */
export async function getSessionFromCookie(
  cookieHeader: string | null
): Promise<SessionInfo | null> {
  if (!cookieHeader) return null;

  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));

  if (!match) return null;
  const token = match.slice(SESSION_COOKIE_NAME.length + 1);
  if (!token) return null;

  try {
    const secret = getSessionSecret();
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    const sessionId = payload.jti;
    const userId = payload.sub;
    const role = payload.role as string | undefined;

    if (
      !sessionId ||
      !userId ||
      (role !== "company" && role !== "freelancer" && role !== "admin")
    ) {
      return null;
    }

    const store = getAuthStore();
    if (store.revokedSessions.has(sessionId)) {
      return null;
    }

    const strict = isStrictSessionPersistence();
    if (strict && !shouldUseDatabaseAuth()) {
      // Strict mode without a database cannot validate persistence: fail
      // closed instead of trusting the signature alone.
      return null;
    }

    if (shouldUseDatabaseAuth()) {
      try {
        const { db } = await import("@/lib/db");
        const { authSessions } = await import("@/lib/db/schema");
        const rows = await db
          .select({
            revokedAt: authSessions.revokedAt,
            expiresAt: authSessions.expiresAt,
          })
          .from(authSessions)
          .where(eq(authSessions.id, sessionId))
          .limit(1);
        const row = rows[0];
        if (row) {
          if (row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) {
            store.revokedSessions.add(sessionId);
            return null;
          }
        } else if (strict) {
          // Unknown session id with no DB row: fail closed in strict mode.
          return null;
        }
      } catch {
        // Ignore if `auth_sessions` table is not yet migrated (demo/dev
        // only — strict mode fails closed when the table is unreadable).
        if (strict) return null;
      }
    }

    return {
      sessionId,
      userId,
      email: (payload.email as string) ?? "",
      name: (payload.name as string) ?? "",
      role,
      companyId: (payload.companyId as string | null) ?? null,
      companyName: (payload.companyName as string | null) ?? null,
      githubHandle: (payload.githubHandle as string | null) ?? null,
      isAuthenticatedUser: true,
    };
  } catch {
    return null;
  }
}

/**
 * Revokes the session identified by the cookie header (both in-memory and in
 * PostgreSQL `auth_sessions`) and returns a clearing Set-Cookie string.
 */
export async function revokeSessionFromCookie(
  cookieHeader: string | null
): Promise<string> {
  const session = await getSessionFromCookie(cookieHeader);
  if (session) {
    const store = getAuthStore();
    store.revokedSessions.add(session.sessionId);
    store.activeSessions.delete(session.sessionId);

    if (shouldUseDatabaseAuth()) {
      try {
        const { db } = await import("@/lib/db");
        const { authSessions } = await import("@/lib/db/schema");
        await db
          .update(authSessions)
          .set({ revokedAt: new Date() })
          .where(eq(authSessions.id, session.sessionId));
      } catch {
        // Ignore if `auth_sessions` table is not yet migrated
      }
    }
  }
  return clearSessionCookie();
}

export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    `Max-Age=0`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
  ].join("; ");
}

/**
 * Resets in-memory auth store (for isolated unit tests only).
 */
export function resetAuthStoreForTests(): void {
  const g = globalThis as unknown as { __consultaiAuthStore?: GlobalAuthStore };
  delete g.__consultaiAuthStore;
}
