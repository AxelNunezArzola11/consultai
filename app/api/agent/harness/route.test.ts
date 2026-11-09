import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));

import { signRoleCookie } from "@/lib/auth/role-cookie";
import { POST as harnessPOST } from "./route";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { db } from "@/lib/db";
import { POST as saveBriefPOST } from "@/app/api/db/save-brief/route";
import { POST as createProjectPOST } from "@/app/api/projects/route";
import { POST as candidatesPOST } from "@/app/api/candidates/route";
import { GET as candidatesSearchGET } from "@/app/api/candidates/search/route";
import { GET as operationsGET } from "@/app/api/operations/data/route";
import { GET as disputeGET, PATCH as disputePATCH } from "@/app/api/disputes/[disputeId]/route";
import { POST as disputeAnalyzePOST } from "@/app/api/disputes/[disputeId]/analyze/route";
import { getDemoTables, resetDemoStore } from "@/lib/demo/store";

describe("Vetting Assistant, Dashboard Brief Activation & Dispute Workflow (Bugs C, D & Section 4)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetDemoStore();
  });

  it("Bug C: Vetting Assistant returns context-aware DEMO response in DEMO_MODE and enforces RBAC", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];

    // 1. DEMO_MODE = true -> explicit [DEMO MODE — Simulated Response] with real project candidates
    const demoReq = new NextRequest("http://localhost:3000/api/agent/harness", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: companyCookie,
      },
      body: JSON.stringify({
        projectId: "demo-project-saas",
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "Which candidate is the strongest fit for this project?" }],
          },
        ],
      }),
    });

    const demoRes = await harnessPOST(demoReq);
    expect(demoRes.status).toBe(200);
    const demoText = await demoRes.text();
    expect(demoText).toContain("[DEMO MODE — Simulated Response]");
    expect(demoText).toContain("Maya Chen");

    // 2. Freelancer role -> 403 Forbidden
    const freelancerCookie = (await signRoleCookie("freelancer")).split(";")[0];
    const forbiddenReq = new NextRequest("http://localhost:3000/api/agent/harness", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: freelancerCookie,
      },
      body: JSON.stringify({
        projectId: "demo-project-saas",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });
    const forbiddenRes = await harnessPOST(forbiddenReq);
    expect(forbiddenRes.status).toBe(403);

    // 3. LIVE mode: a session-less company cookie -> 403 (D.3 session
    // requirement), while a session-authenticated live caller without
    // GROQ_API_KEY still gets the honest 503 ai_provider_unconfigured
    // (no silent fake AI claims).
    const prevDemo = process.env.DEMO_MODE;
    const prevGroq = process.env.GROQ_API_KEY;
    const prevSecret = process.env.ROLE_COOKIE_SECRET;
    try {
      process.env.DEMO_MODE = "false";
      process.env.ROLE_COOKIE_SECRET = "0123456789abcdef0123456789abcdef";
      delete process.env.GROQ_API_KEY;
      const liveCookie = (await signRoleCookie("company")).split(";")[0];
      const liveReq = (cookie: string) =>
        new NextRequest("http://localhost:3000/api/agent/harness", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie,
          },
          body: JSON.stringify({
            projectId: "demo-project-saas",
            messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
          }),
        });
      const sessionlessRes = await harnessPOST(liveReq(liveCookie));
      expect(sessionlessRes.status).toBe(403);
      expect(((await sessionlessRes.json()) as { error: string }).error).toBe(
        "missing_company_context"
      );

      const reg = await registerPOST(
        new NextRequest("http://localhost:3000/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountType: "company",
            companyName: "Harness Live Co",
            contactName: "Synthetic Owner",
            email: "harness-live@consultai.test",
            password: "SyntheticPass2026!",
            termsAccepted: true,
          }),
        })
      );
      expect(reg.status).toBe(201);
      const regBody = (await reg.json()) as { user: { companyId: string } };
      const sessionCookie = (reg.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(";")[0])
        .join("; ");
      // The live ownership check reads the project row; queue the matching
      // company so the session-authenticated call reaches the GROQ check.
      // (loadProjectContext degrades gracefully past the queue.)
      const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
      selectMock.mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: async () => [{ companyId: regBody.user.companyId }] }),
        }),
      });
      const liveUnconfigRes = await harnessPOST(liveReq(sessionCookie));
      expect(liveUnconfigRes.status).toBe(503);
      const errBody = await liveUnconfigRes.json();
      expect(errBody.error).toBe("ai_provider_unconfigured");
    } finally {
      process.env.DEMO_MODE = prevDemo;
      if (prevGroq !== undefined) process.env.GROQ_API_KEY = prevGroq;
      if (prevSecret !== undefined) {
        process.env.ROLE_COOKIE_SECRET = prevSecret;
      } else {
        delete process.env.ROLE_COOKIE_SECRET;
      }
    }
  });

  it("Bug B: Candidate creation normalizes @username and GitHub URL, prevents duplicates, and surfaces in AG Grid & search", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];

    // 1. Add candidate using @AxelNunezArzola11
    const createRes = await candidatesPOST(
      new NextRequest("http://localhost:3000/api/candidates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: companyCookie,
        },
        body: JSON.stringify({
          projectId: "demo-project-saas",
          name: "Axel Nunez Arzola",
          email: "axel.synthetic@consultai.test",
          githubHandle: "@AxelNunezArzola11",
          canDo: ["TypeScript", "Next.js", "Multi-Agent Systems"],
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const createdData = await createRes.json();
    expect(createdData.candidate.githubHandle).toBe("axelnunezarzola11");
    expect(createdData.alreadyExists).toBe(false);

    // 2. Duplicate submission via full GitHub URL returns 200 alreadyExists:true (no duplicate row)
    const dupRes = await candidatesPOST(
      new NextRequest("http://localhost:3000/api/candidates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: companyCookie,
        },
        body: JSON.stringify({
          projectId: "demo-project-saas",
          name: "Axel Nunez Arzola",
          email: "axel.synthetic@consultai.test",
          githubHandle: "https://github.com/AxelNunezArzola11",
        }),
      })
    );
    expect(dupRes.status).toBe(200);
    const dupData = await dupRes.json();
    expect(dupData.alreadyExists).toBe(true);
    expect(dupData.candidate.id).toBe(createdData.candidate.id);

    // 3. Search by plain handle, @handle, and full GitHub URL all match the candidate
    for (const q of [
      "AxelNunezArzola11",
      "@AxelNunezArzola11",
      "https://github.com/AxelNunezArzola11",
    ]) {
      const searchRes = await candidatesSearchGET(
        new NextRequest(
          `http://localhost:3000/api/candidates/search?q=${encodeURIComponent(q)}&projectId=demo-project-saas`,
          { headers: { cookie: companyCookie } }
        )
      );
      expect(searchRes.status).toBe(200);
      const searchData = await searchRes.json();
      expect(
        searchData.results.some(
          (c: { githubHandle: string }) => c.githubHandle === "axelnunezarzola11"
        )
      ).toBe(true);
    }

    // 4. Immediately appears in AG Grid Operations data (/api/operations/data -> consultants)
    const opsRes = await operationsGET(
      new NextRequest("http://localhost:3000/api/operations/data?projectId=demo-project-saas", {
        headers: { cookie: companyCookie },
      })
    );
    expect(opsRes.status).toBe(200);
    const opsData = await opsRes.json();
    expect(
      opsData.consultants.some(
        (c: { githubHandle: string }) => c.githubHandle === "axelnunezarzola11"
      )
    ).toBe(true);
  });

  it("Bug D: Saving a project brief updates the project title to 'AI dashboard' and sets status to 'active'", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];

    // Create draft project with default title "New project"
    const projectId = "proj-ai-dashboard-test";
    const createRes = await createProjectPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: companyCookie,
        },
        body: JSON.stringify({
          projectId,
          title: "New project",
          brief: "Build an AI dashboard for enterprise analytics.",
        }),
      })
    );
    expect(createRes.status).toBe(201);

    // Save brief with projectTitle = "AI dashboard"
    const saveRes = await saveBriefPOST(
      new NextRequest("http://localhost:3000/api/db/save-brief", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: companyCookie,
        },
        body: JSON.stringify({
          projectId,
          agentSessionId: "sess-brief-1",
          plan: {
            projectTitle: "AI dashboard",
            projectSummary: "Enterprise analytics AI dashboard with real-time KPIs",
            totalBudgetUsd: 3500,
            milestones: [
              {
                id: "m1",
                title: "M1: Core Dashboard UI & Telemetry",
                description: "Build Next.js dashboard routes and KPI cards",
                budgetUsd: 3500,
                dueDaysOffset: 7,
                acceptanceCriteria: [
                  {
                    id: "ac-1",
                    description: "Renders KPI metrics under 200ms",
                    kind: "ci_passes",
                  },
                ],
              },
            ],
          },
        }),
      })
    );

    expect(saveRes.status).toBe(200);
    const saveData = await saveRes.json();
    expect(saveData.status).toBe("active");
    expect(saveData.projectTitle).toBe("AI dashboard");

    const tables = getDemoTables();
    const updatedProj = tables.projects.find((p) => p.id === projectId);
    expect(updatedProj?.title).toBe("AI dashboard");
    expect(updatedProj?.status).toBe("active");
  });

  it("Section 4: Dispute details, AI analysis, and human-gated resolution work end-to-end", async () => {
    const companyCookie = (await signRoleCookie("company")).split(";")[0];
    const disputeId = "demo-dispute-1";

    const getRes = await disputeGET(
      new NextRequest(`http://localhost:3000/api/disputes/${disputeId}`, {
        headers: { cookie: companyCookie },
      }),
      { params: Promise.resolve({ disputeId }) }
    );
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.dispute.id).toBe(disputeId);
    expect(getData.evidencePacket.isComplete).toBe(true);

    // Run AI Dispute Analysis
    const analyzeRes = await disputeAnalyzePOST(
      new NextRequest(`http://localhost:3000/api/disputes/${disputeId}/analyze`, {
        method: "POST",
        headers: { cookie: companyCookie },
      }),
      { params: Promise.resolve({ disputeId }) }
    );
    expect(analyzeRes.status).toBe(200);
    const analyzeData = await analyzeRes.json();
    expect(analyzeData.proposal.proposedAction).toBe("PROVIDE_EVIDENCE");

    // Record human-gated resolution
    const patchRes = await disputePATCH(
      new NextRequest(`http://localhost:3000/api/disputes/${disputeId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          cookie: companyCookie,
        },
        body: JSON.stringify({
          action: "RECORD_EVIDENCE",
          note: "Verified PR #87 and mockups v3 fulfill milestone requirements.",
        }),
      }),
      { params: Promise.resolve({ disputeId }) }
    );
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.dispute.evidenceStatus).toBe("submitted");
  });
});
