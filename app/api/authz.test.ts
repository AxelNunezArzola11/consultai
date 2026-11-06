/**
 * Server-side authorization tests.
 *
 * Hiding buttons in the UI is not authorization: every mutating route must
 * reject unauthenticated and wrong-role callers with 401/403 BEFORE touching
 * any data. These tests invoke the real route handlers with real
 * (unsigned/absent/role) cookies.
 *
 * Env: ROLE_COOKIE_SECRET is set to a test value; DEMO_MODE is off so the
 * live guards (not demo branches) are exercised. Guards run before any DB
 * access, so no DATABASE_URL is needed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";

process.env.ROLE_COOKIE_SECRET = "test-secret-0123456789abcdef-test-secret";
process.env.DEMO_MODE = "";

import { signRoleCookie, type Role } from "@/lib/auth/role-cookie";
import { POST as projectsPost } from "@/app/api/projects/route";
import { POST as ndaGeneratePost } from "@/app/api/nda/generate/route";
import { POST as ndaRegeneratePost } from "@/app/api/nda/regenerate/route";
import { POST as demoResetPost } from "@/app/api/demo/reset/route";
import { POST as saveBriefPost } from "@/app/api/db/save-brief/route";
import { PATCH as operationsPatch } from "@/app/api/operations/data/route";
import { POST as aiExecutePost } from "@/app/api/ai-ops/execute/route";
import { POST as planningPost } from "@/app/api/ai/planning/route";
import { PUT as consentPut } from "@/app/api/agent/vetting/consent/route";

function jsonRequest(
  url: string,
  method: string,
  body: unknown,
  cookieHeader: string | null
): NextRequest {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookieHeader) headers.set("Cookie", cookieHeader.split(";")[0]);
  return new NextRequest(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

let companyCookie = "";
let freelancerCookie = "";

beforeAll(async () => {
  companyCookie = await signRoleCookie("company" satisfies Role);
  freelancerCookie = await signRoleCookie("freelancer" satisfies Role);
});

describe("unauthenticated callers are rejected", () => {
  const cases: Array<[string, () => Promise<Response>, number]> = [
    [
      "POST /api/projects",
      () =>
        projectsPost(
          jsonRequest("http://x/api/projects", "POST", { projectId: "p1" }, null)
        ),
      403,
    ],
    [
      "POST /api/nda/generate",
      () =>
        ndaGeneratePost(
          jsonRequest(
            "http://x/api/nda/generate",
            "POST",
            { candidateId: "c", projectId: "p" },
            null
          )
        ),
      403,
    ],
    [
      "POST /api/nda/regenerate",
      () =>
        ndaRegeneratePost(
          jsonRequest("http://x/api/nda/regenerate", "POST", { ndaId: "n" }, null)
        ),
      403,
    ],
    [
      "POST /api/db/save-brief",
      () =>
        saveBriefPost(
          jsonRequest(
            "http://x/api/db/save-brief",
            "POST",
            { projectId: "p", agentSessionId: "s", plan: {} },
            null
          )
        ),
      403,
    ],
    [
      "PATCH /api/operations/data",
      () =>
        operationsPatch(
          jsonRequest(
            "http://x/api/operations/data",
            "PATCH",
            { entity: "task", id: "t", updates: { title: "x" } },
            null
          )
        ),
      403,
    ],
    [
      "POST /api/ai-ops/execute",
      () =>
        aiExecutePost(
          jsonRequest(
            "http://x/api/ai-ops/execute",
            "POST",
            { user_request: "hi" },
            null
          )
        ),
      403,
    ],
    [
      "POST /api/ai/planning",
      () =>
        planningPost(
          jsonRequest(
            "http://x/api/ai/planning",
            "POST",
            { message: "delay by 3 days" },
            null
          )
        ),
      403,
    ],
    [
      "PUT /api/agent/vetting/consent",
      () =>
        consentPut(
          jsonRequest(
            "http://x/api/agent/vetting/consent",
            "PUT",
            { candidateId: "c", projectId: "p" },
            null
          )
        ),
      403,
    ],
  ];

  for (const [name, call, expected] of cases) {
    it(`${name} → ${expected} without a role cookie`, async () => {
      const res = await call();
      expect(res.status).toBe(expected);
    });
  }
});

describe("freelancer role cannot perform company mutations", () => {
  it("PATCH /api/operations/data → 403 for freelancer", async () => {
    const res = await operationsPatch(
      jsonRequest(
        "http://x/api/operations/data",
        "PATCH",
        { entity: "task", id: "t", updates: { title: "x" } },
        freelancerCookie
      )
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/nda/generate → 403 for freelancer", async () => {
    const res = await ndaGeneratePost(
      jsonRequest(
        "http://x/api/nda/generate",
        "POST",
        { candidateId: "c", projectId: "p" },
        freelancerCookie
      )
    );
    expect(res.status).toBe(403);
  });

  it("PUT /api/agent/vetting/consent → 403 for freelancer", async () => {
    const res = await consentPut(
      jsonRequest(
        "http://x/api/agent/vetting/consent",
        "PUT",
        { candidateId: "c", projectId: "p" },
        freelancerCookie
      )
    );
    expect(res.status).toBe(403);
  });
});

describe("demo reset is doubly gated", () => {
  it("POST /api/demo/reset → 403 when DEMO_MODE is off (even for company)", async () => {
    const res = await demoResetPost(
      jsonRequest("http://x/api/demo/reset", "POST", {}, companyCookie)
    );
    expect(res.status).toBe(403);
  });
});
