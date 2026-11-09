import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signRoleCookie } from "@/lib/auth/role-cookie";
import { generateNdaPdf } from "@/lib/nda/generate";
import { POST as generateNdaPOST } from "@/app/api/nda/generate/route";
import { POST as acceptNdaPOST } from "@/app/api/nda/accept/route";
import { resolveNdaDetails } from "@/lib/nda/details";
import { resetDemoStore } from "@/lib/demo/store";
import { createHash } from "crypto";

describe("NDA Generation, Reissue Idempotency & Acceptance Replay (Bug A)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetDemoStore();
  });

  it("generates a valid PDF without crashing on Unicode symbols (⚠️, —) in template text", async () => {
    const result = await generateNdaPdf({
      companyName: "TechNova Enterprises",
      projectTitle: "AI — Enterprise Platform",
      candidateName: "Jordan Kim",
    });

    expect(result.pdfBytes.byteLength).toBeGreaterThan(500);
    expect(result.documentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.documentText).toContain("Jordan Kim");
  });

  it("creates an NDA for a candidate, supports idempotent token reissue, records acceptance, and returns 409 already_accepted on replay", async () => {
    const companyCookie = await signRoleCookie("company");
    const cookieHeader = companyCookie.split(";")[0];

    // 1. Send NDA to demo-cand-lena (status = shortlisted)
    const genReq = new NextRequest("http://localhost:3000/api/nda/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify({
        projectId: "demo-project-saas",
        candidateId: "demo-cand-lena",
      }),
    });

    const genRes = await generateNdaPOST(genReq);
    expect(genRes.status).toBe(200);
    const genData = await genRes.json();
    expect(genData.invitePath).toMatch(/^\/invite\//);
    expect(genData.inviteUrl).toContain("/invite/");

    // 2. Re-sending NDA when status is already nda_sent reissues a usable invite link (200)
    const reissueReq = new NextRequest("http://localhost:3000/api/nda/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify({
        projectId: "demo-project-saas",
        candidateId: "demo-cand-lena",
      }),
    });
    const reissueRes = await generateNdaPOST(reissueReq);
    expect(reissueRes.status).toBe(200);
    const reissueData = await reissueRes.json();
    expect(reissueData.reissued).toBe(true);

    const token = decodeURIComponent(
      reissueData.invitePath.replace("/invite/", "")
    );

    // 3. Resolve NDA details via token
    const resolved = await resolveNdaDetails(token);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const docHash = createHash("sha256")
      .update(resolved.details.documentText, "utf8")
      .digest("hex");

    // 4. Accept NDA
    const acceptReq = new NextRequest("http://localhost:3000/api/nda/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        typedName: "Lena Fischer",
        agreed: true,
        documentHash: docHash,
      }),
    });
    const acceptRes = await acceptNdaPOST(acceptReq);
    expect(acceptRes.status).toBe(200);

    // 5. Replay the same token after acceptance -> returns 409 already_accepted
    const replayReq = new NextRequest("http://localhost:3000/api/nda/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        typedName: "Lena Fischer",
        agreed: true,
        documentHash: docHash,
      }),
    });
    const replayRes = await acceptNdaPOST(replayReq);
    expect(replayRes.status).toBe(409);
    const replayData = await replayRes.json();
    expect(replayData.error).toBe("already_accepted");
  });
});
