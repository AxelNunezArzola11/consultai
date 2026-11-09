/**
 * lib/auth/password.ts
 *
 * Secure password hashing and strength validation using Node's native
 * `crypto.scrypt` with random 16-byte salts and constant-time comparison
 * (`crypto.timingSafeEqual`).
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCb);

const SALT_BYTES = 16;
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Enforces sensible password strength requirements without leaking passwords:
 * - Minimum 8 characters, maximum 128 characters
 * - At least one letter and one number
 */
export function validatePasswordStrength(
  password: string
): PasswordValidationResult {
  const errors: string[] = [];

  if (typeof password !== "string" || password.length < 8) {
    errors.push("Password must be at least 8 characters long.");
  }
  if (typeof password === "string" && password.length > 128) {
    errors.push("Password must not exceed 128 characters.");
  }
  if (typeof password === "string" && !/[A-Za-z]/.test(password)) {
    errors.push("Password must contain at least one letter.");
  }
  if (typeof password === "string" && !/[0-9]/.test(password)) {
    errors.push("Password must contain at least one number.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Hashes a plaintext password using `crypto.scrypt` with a fresh random salt.
 * Format: `scrypt$N$r$p$<saltHex>$<derivedKeyHex>`
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = (await scrypt(
    password,
    salt,
    KEY_LENGTH
  )) as Buffer;

  return [
    "scrypt",
    String(SCRYPT_PARAMS.N),
    String(SCRYPT_PARAMS.r),
    String(SCRYPT_PARAMS.p),
    salt.toString("hex"),
    derivedKey.toString("hex"),
  ].join("$");
}

/**
 * Verifies a plaintext password against a stored `scrypt$...` hash using
 * constant-time comparison (`timingSafeEqual`).
 * Never throws; returns `false` on malformed hashes or mismatches.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  try {
    if (!password || !storedHash) return false;
    const parts = storedHash.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
      return false;
    }

    const saltHex = parts[4];
    const keyHex = parts[5];
    if (!saltHex || !keyHex) return false;

    const salt = Buffer.from(saltHex, "hex");
    const expectedKey = Buffer.from(keyHex, "hex");
    if (salt.length === 0 || expectedKey.length === 0) return false;

    const derivedKey = (await scrypt(
      password,
      salt,
      expectedKey.length
    )) as Buffer;

    if (derivedKey.length !== expectedKey.length) return false;
    return timingSafeEqual(derivedKey, expectedKey);
  } catch {
    return false;
  }
}
