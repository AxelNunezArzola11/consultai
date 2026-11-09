/**
 * Demo rehydration tests for POST /api/db/save-brief.
 *
 * The planner's Approve & Save runs on a serverless instance that may never
 * have seen the creation POST. On a demo-store miss carrying the creation
 * title, the route rehydrates the POST-accepted draft and saves against it;
 * bare IDs still 404 honestly.
 *
 * Runs against the isolated in-memory demo store + auth store with synthetic
 * fixtures only. No database, no network, no Production data.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as savePOST } from "./route";
import { resetAuthStoreForTests } from "@/lib/auth/session";
import { getDemoTables, resetDemoStore } from "@/lib/demo/store";

const VALID_PLAN = {
  projectTitle: "Save Test",
  projectSummary: "A synthetic plan for save tests.",
  totalBudgetUsd: 5000,
  milestones: [
    {
      id: "m1",
      title: "Milestone One",
      description: "First synthetic milestone.",
      budgetUsd: 5000,
      dueDaysOffset: 7,
      acceptanceCriteria: [{ id: "m1-c1", description: "Done", kind: "SUBJECTIVE" }],
    },
  ],
};

function saveReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost:3000/api/db/save-brief", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/db/save-brief demo rehydration (serverless-safe)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("demo miss without title → 404 preserved", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await savePOST(
      saveReq(
        {
          projectId: "save-ghost-no-title",
          agentSessionId: "save_sess_synthetic1",
          plan: VALID_PLAN,
        },
        companyCookie
      )
    );
    expect(res.status).toBe(404);
  });

  it("demo miss with title passes the project gate (invalid plan → 422, not 404)", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const res = await savePOST(
      saveReq(
        {
          projectId: "save-rehydrated-1",
          agentSessionId: "save_sess_synthetic2",
          plan: { nope: "not a plan" },
          projectTitle: "Rehydrated Save",
        },
        companyCookie
      )
    );
    // 422 proves rehydration happened: an unknown project would be 404.
    expect(res.status).toBe(422);
    expect(
      getDemoTables().projects.find((p) => p.id === "save-rehydrated-1")?.title
    ).toBe("Rehydrated Save");
  });

  it("cross-instance: save with title persists plan + milestones on rehydrated draft", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    // Fresh serverless instance from the start: empty store, creation params
    // arrive with the save request itself.
    const res = await savePOST(
      saveReq(
        {
          projectId: "save-x-instance",
          agentSessionId: "save_sess_synthetic3",
          plan: VALID_PLAN,
          projectTitle: "Save X Instance",
        },
        companyCookie
      )
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; milestoneCount: number };
    expect(data.ok).toBe(true);
    expect(data.milestoneCount).toBe(1);
    const stored = getDemoTables().projects.find(
      (p) => p.id === "save-x-instance"
    )!;
    expect(stored.status).toBe("active");
    expect(
      getDemoTables().milestones.filter((m) => m.projectId === "save-x-instance")
    ).toHaveLength(1);
  });
});
