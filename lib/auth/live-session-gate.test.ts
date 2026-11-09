/**
 * Unit tests for companySessionAllowsLiveAccess (D.3 cookie-stripping defense).
 *
 * A company role cookie alone must never authorize company access outside
 * demo mode: stripping `consultai_session_v1` would otherwise silently drop
 * every session-keyed ownership check (cross-company bypass). Admin keeps
 * its explicit global contract; demo mode keeps switcher parity.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  companySessionAllowsLiveAccess,
  type SessionInfo,
} from "./session";
import type { Role } from "./role-cookie";

function companySession(companyId: string | null): SessionInfo {
  return {
    sessionId: "sess-1",
    userId: "user-1",
    email: "owner@consultai.test",
    name: "Owner",
    role: "company",
    companyId,
    companyName: "Synthetic Co",
    githubHandle: null,
    isAuthenticatedUser: true,
  };
}

describe("companySessionAllowsLiveAccess", () => {
  const prevDemo = process.env.DEMO_MODE;
  beforeEach(() => {
    process.env.DEMO_MODE = "false";
  });
  afterEach(() => {
    process.env.DEMO_MODE = prevDemo;
  });

  it("allows non-company roles regardless of session (their own gates decide)", () => {
    const roles: Array<Role | null> = ["admin", "freelancer", null];
    for (const role of roles) {
      expect(companySessionAllowsLiveAccess(role, null)).toBe(true);
      expect(companySessionAllowsLiveAccess(role, companySession("company-a"))).toBe(true);
    }
  });

  it("allows session-less company in demo mode (switcher parity)", () => {
    process.env.DEMO_MODE = "true";
    expect(companySessionAllowsLiveAccess("company", null)).toBe(true);
  });

  it("rejects session-less company in live mode (stripped-cookie bypass closed)", () => {
    expect(companySessionAllowsLiveAccess("company", null)).toBe(false);
  });

  it("rejects live company sessions without a companyId (null or empty)", () => {
    expect(companySessionAllowsLiveAccess("company", companySession(null))).toBe(false);
    expect(companySessionAllowsLiveAccess("company", companySession(""))).toBe(false);
  });

  it("rejects a company role paired with a non-company session", () => {
    const freelancerSession: SessionInfo = {
      ...companySession(null),
      role: "freelancer",
    };
    expect(companySessionAllowsLiveAccess("company", freelancerSession)).toBe(false);
  });

  it("allows a live company session carrying companyId", () => {
    expect(companySessionAllowsLiveAccess("company", companySession("company-a"))).toBe(true);
  });
});
