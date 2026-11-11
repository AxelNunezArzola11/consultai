/**
 * Regression tests for the Demo Inbox role gating.
 *
 * Freelancers must never be offered the "Issue invite link" control: the
 * server rejects issuance for their role with 403, so showing the button
 * is a broken promise. Company/admin viewers keep the control.
 *
 * Renders the server component in demo mode (fictional fixtures, no DB)
 * with a mocked page guard and inspects the InviteLinkManager props in
 * the returned element tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth/guards", () => ({
  requirePageRole: vi.fn(),
  candidateIdsForFreelancer: vi.fn(async () => []),
}));

import { requirePageRole } from "@/lib/auth/guards";
import DemoInboxPage from "./page";
import { InviteLinkManager } from "./InviteLinkManager";
import { getDemoTables, resetDemoStore } from "@/lib/demo/store";

const requirePageRoleMock = requirePageRole as unknown as ReturnType<
  typeof vi.fn
>;

interface ManagerProps {
  ndaId: string;
  canIssue: boolean;
}

function findInviteManagers(el: unknown): ManagerProps[] {
  const acc: ManagerProps[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: unknown;
      props?: Record<string, unknown>;
    };
    if (n.type === InviteLinkManager) {
      acc.push({
        ndaId: n.props?.ndaId as string,
        canIssue: n.props?.canIssue as boolean,
      });
    }
    const children = n.props?.children;
    if (Array.isArray(children)) children.forEach(walk);
    else walk(children);
  };
  walk(el);
  return acc;
}

describe("Demo Inbox invite-link gating", () => {
  const savedDemo = process.env.DEMO_MODE;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEMO_MODE = "true";
    resetDemoStore();
    // Fixtures ship accepted NDAs only; the inbox lists sent ones.
    getDemoTables().ndas[0].status = "sent";
  });

  afterEach(() => {
    process.env.DEMO_MODE = savedDemo;
    resetDemoStore();
  });

  function authAs(role: "company" | "freelancer" | "admin") {
    requirePageRoleMock.mockResolvedValue({
      session: null,
      role,
      demoBypass: true,
    });
  }

  it("freelancer sees invitation cards with issuance disabled", async () => {
    authAs("freelancer");
    const managers = findInviteManagers(await DemoInboxPage());
    expect(managers.length).toBeGreaterThan(0);
    for (const m of managers) {
      expect(m.canIssue).toBe(false);
    }
  });

  it("company viewer keeps the issuance control", async () => {
    authAs("company");
    const managers = findInviteManagers(await DemoInboxPage());
    expect(managers.length).toBeGreaterThan(0);
    for (const m of managers) {
      expect(m.canIssue).toBe(true);
    }
  });

  it("admin viewer keeps the issuance control", async () => {
    authAs("admin");
    const managers = findInviteManagers(await DemoInboxPage());
    expect(managers.length).toBeGreaterThan(0);
    for (const m of managers) {
      expect(m.canIssue).toBe(true);
    }
  });
});
