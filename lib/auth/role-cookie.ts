/**
 * Role cookie — signed, httpOnly, demo auth.
 *
 * SECURITY NOTE: This is demo-only auth, not production auth.
 * The role is HMAC-SHA256 signed to prevent trivial tampering,
 * but there is no real user identity or session management.
 * See plan section 14 (P0-5 Role switcher).
 *
 * Cookie: consultai_role_v1
 *   Value format: <role>.<base64url(sig)>
 *   role: "company" | "freelancer"
 *   sig: HMAC-SHA256(role, ROLE_COOKIE_SECRET)
 *
 * Env: ROLE_COOKIE_SECRET — required, min 32 chars.
 */

import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "consultai_role_v1";
const MAX_AGE_S = 60 * 60 * 24; // 24 hours

function getSecret(): Uint8Array {
  const secret = process.env.ROLE_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "ROLE_COOKIE_SECRET must be set and at least 32 characters. " +
        "Generate with: openssl rand -hex 32"
    );
  }
  return new TextEncoder().encode(secret);
}

export type Role = "company" | "freelancer";

/**
 * Signs a role into a compact JWT and returns the Set-Cookie header value.
 * Uses HS256 (HMAC-SHA256) via jose.
 */
export async function signRoleCookie(role: Role): Promise<string> {
  const secret = getSecret();
  const token = await new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(secret);

  const isProd = process.env.NODE_ENV === "production";
  // httpOnly; SameSite=Strict; Secure in production
  return [
    `${COOKIE_NAME}=${token}`,
    `Max-Age=${MAX_AGE_S}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    ...(isProd ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Returns the role from the request cookie, or null if absent/invalid/expired.
 * Never throws — always returns null on any error.
 */
export async function getRoleFromCookie(
  cookieHeader: string | null
): Promise<Role | null> {
  if (!cookieHeader) return null;

  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));

  if (!match) return null;

  const token = match.slice(COOKIE_NAME.length + 1);
  if (!token) return null;

  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    const role = payload.role as string | undefined;
    if (role === "company" || role === "freelancer") return role;
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns a Set-Cookie header that clears the role cookie.
 */
export function clearRoleCookie(): string {
  return [
    `${COOKIE_NAME}=`,
    `Max-Age=0`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
  ].join("; ");
}

export { COOKIE_NAME };
