import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
} from "./password";
import {
  resetAuthStoreForTests,
  getSessionFromCookie,
} from "./session";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as projectsPOST, GET as projectsGET } from "@/app/api/projects/route";
import { GET as ledgerGET } from "@/app/api/projects/[id]/ledger/route";
import { GET as operationsGET } from "@/app/api/operations/data/route";
import { resetDemoStore } from "@/lib/demo/store";

function extractCookies(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies.map((c) => c.split(";")[0]).join("; ");
  }
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

describe("Secure Account Registration, Login, Sessions & Isolation (Section 3)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetAuthStoreForTests();
    resetDemoStore();
  });

  it("hashes passwords with scrypt and verifies with timingSafeEqual", async () => {
    const pw = "StrongPass2026!";
    const check = validatePasswordStrength(pw);
    expect(check.valid).toBe(true);

    const hash = await hashPassword(pw);
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(pw, hash)).toBe(true);
    expect(await verifyPassword("WrongPass2026!", hash)).toBe(false);
  });

  it("registers a company account, rejects duplicates, logs in, and invalidates session on logout", async () => {
    const regReq = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountType: "company",
        companyName: "Nova AI Labs",
        contactName: "Elena Vance",
        email: "elena@nova-labs.test",
        password: "NovaPassword123!",
        confirmPassword: "NovaPassword123!",
        termsAccepted: true,
      }),
    });

    const regRes = await registerPOST(regReq);
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    expect(regData.ok).toBe(true);
    expect(regData.user.role).toBe("company");
    expect(regData.redirectTo).toBe("/dashboard");

    const cookies = extractCookies(regRes);
    const session = await getSessionFromCookie(cookies);
    expect(session).not.toBeNull();
    expect(session?.email).toBe("elena@nova-labs.test");

    // Duplicate registration with same email must return 409
    const dupReq = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountType: "company",
        companyName: "Duplicate Corp",
        contactName: "Dup User",
        email: "ELENA@nova-labs.test",
        password: "NovaPassword123!",
        termsAccepted: true,
      }),
    });
    const dupRes = await registerPOST(dupReq);
    expect(dupRes.status).toBe(409);

    // Wrong password returns 401
    const badLoginReq = new NextRequest("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "elena@nova-labs.test",
        password: "WrongPassword999",
      }),
    });
    const badLoginRes = await loginPOST(badLoginReq);
    expect(badLoginRes.status).toBe(401);

    // Valid login returns 200
    const loginReq = new NextRequest("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "elena@nova-labs.test",
        password: "NovaPassword123!",
      }),
    });
    const loginRes = await loginPOST(loginReq);
    expect(loginRes.status).toBe(200);
    const loginCookies = extractCookies(loginRes);

    // Logout revokes the session token server-side
    const logoutReq = new NextRequest("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: { cookie: loginCookies },
    });
    const logoutRes = await logoutPOST(logoutReq);
    expect(logoutRes.status).toBe(200);

    // Reusing old cookie after logout returns null session
    const afterLogout = await getSessionFromCookie(loginCookies);
    expect(afterLogout).toBeNull();
  });

  it("prevents self-registration of admin role and isolates Company A from Company B projects", async () => {
    const adminAttempt = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountType: "admin",
        email: "hacker@test.local",
        password: "AdminPassword123!",
      }),
    });
    const adminRes = await registerPOST(adminAttempt);
    expect(adminRes.status).toBe(403);

    // Register Company A
    const compARes = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "company",
          companyName: "Alpha Corp",
          contactName: "Alice",
          email: "alice@alpha.test",
          password: "AlphaPassword123!",
          termsAccepted: true,
        }),
      })
    );
    const compACookies = extractCookies(compARes);

    // Register Company B
    const compBRes = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "company",
          companyName: "Beta Corp",
          contactName: "Bob",
          email: "bob@beta.test",
          password: "BetaPassword123!",
          termsAccepted: true,
        }),
      })
    );
    const compBCookies = extractCookies(compBRes);

    // Register Freelancer
    const freeRes = await registerPOST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "freelancer",
          fullName: "Carlos Dev",
          email: "carlos@freelance.test",
          specialty: "Backend Engineer",
          githubUsername: "@AxelNunezArzola11",
          password: "FreelancePassword123!",
          termsAccepted: true,
        }),
      })
    );
    expect(freeRes.status).toBe(201);
    const freeData = await freeRes.json();
    expect(freeData.user.githubHandle).toBe("axelnunezarzola11");
    const freeCookies = extractCookies(freeRes);

    // Company A creates a project
    const createProjRes = await projectsPOST(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: compACookies,
        },
        body: JSON.stringify({
          projectId: "proj-alpha-secret-1",
          title: "Alpha Confidential Project",
        }),
      })
    );
    expect(createProjRes.status).toBe(201);

    // Company B lists projects -> must NOT see Company A's project
    const listBRes = await projectsGET(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "GET",
        headers: { cookie: compBCookies },
      })
    );
    expect(listBRes.status).toBe(200);
    const listBData = await listBRes.json();
    const bIds = (listBData.projects as Array<{ id: string }>).map((p) => p.id);
    expect(bIds).not.toContain("proj-alpha-secret-1");

    // Freelancer attempting to create or list company projects gets 403
    const freeListRes = await projectsGET(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "GET",
        headers: { cookie: freeCookies },
      })
    );
    expect(freeListRes.status).toBe(403);

    // Freelancer attempting to read company financial ledger or operations data gets 403
    const freeLedgerRes = await ledgerGET(
      new NextRequest("http://localhost:3000/api/projects/proj-alpha-secret-1/ledger", {
        method: "GET",
        headers: { cookie: freeCookies },
      }),
      { params: Promise.resolve({ id: "proj-alpha-secret-1" }) }
    );
    expect(freeLedgerRes.status).toBe(403);

    const freeOpsRes = await operationsGET(
      new NextRequest("http://localhost:3000/api/operations/data", {
        method: "GET",
        headers: { cookie: freeCookies },
      })
    );
    expect(freeOpsRes.status).toBe(403);

    // Company B attempting to read Company A's financial ledger gets 403
    const compBLedgerRes = await ledgerGET(
      new NextRequest("http://localhost:3000/api/projects/proj-alpha-secret-1/ledger", {
        method: "GET",
        headers: { cookie: compBCookies },
      }),
      { params: Promise.resolve({ id: "proj-alpha-secret-1" }) }
    );
    expect(compBLedgerRes.status).toBe(403);
  });

  it("enforces CSRF Origin verification and brute-force lockout", async () => {
    // Cross-origin request with mismatched Origin header is rejected with 403
    const csrfReq = new NextRequest("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil-attacker.example.com",
        Host: "localhost:3000",
      },
      body: JSON.stringify({
        email: "founder@acme-demo.consultai.local",
        password: "DemoCompany2026!",
      }),
    });
    const csrfRes = await loginPOST(csrfReq);
    expect(csrfRes.status).toBe(403);
    const csrfData = await csrfRes.json();
    expect(csrfData.error).toBe("csrf_origin_mismatch");

    // 5 failed login attempts trigger 429 account_locked on the 6th attempt
    for (let i = 0; i < 5; i++) {
      const failRes = await loginPOST(
        new NextRequest("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "lockout-target@acme-demo.consultai.local",
            password: "WrongPassword!",
          }),
        })
      );
      expect(failRes.status).toBe(401);
    }

    const lockedRes = await loginPOST(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "lockout-target@acme-demo.consultai.local",
          password: "WrongPassword!",
        }),
      })
    );
    expect(lockedRes.status).toBe(429);
    const lockedData = await lockedRes.json();
    expect(lockedData.error).toBe("account_locked");
  });
});
