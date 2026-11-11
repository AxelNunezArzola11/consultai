/**
 * Tests — NDA invite-link issuance permission.
 *
 * Locks the UI/API parity contract: exactly the roles the API accepts
 * (company, admin) are shown the issuance control. A freelancer must
 * never be offered a button the server would reject.
 */

import { describe, it, expect } from "vitest";
import { canIssueNdaInviteLinks } from "./invite-permissions";

describe("canIssueNdaInviteLinks", () => {
  it("allows company and admin roles", () => {
    expect(canIssueNdaInviteLinks("company")).toBe(true);
    expect(canIssueNdaInviteLinks("admin")).toBe(true);
  });

  it("denies freelancers and unauthenticated callers", () => {
    expect(canIssueNdaInviteLinks("freelancer")).toBe(false);
    expect(canIssueNdaInviteLinks(null)).toBe(false);
  });
});
