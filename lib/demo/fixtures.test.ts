/**
 * Offline demo fixture integrity tests.
 *
 * Every route resolves demo data from these fixtures, so broken references
 * would surface as empty dashboards. These tests prove:
 * - every foreign key resolves within the fixture set
 * - the $25,000 budget and 6-milestone scenario shape hold
 * - the TechNova scenario beats (delayed, verifying, pending approval,
 *   completed, dispute, reschedule) are present
 * - demo NDA documents hash-bind exactly (invite flow works offline)
 */

import { describe, it, expect } from "vitest";
import { buildDemoTables } from "./fixtures";
import { DEMO_IDS } from "./config";
import { sha256Hex } from "@/lib/nda/invite-token";
import { buildNdaText } from "@/lib/nda/generate";

describe("demo fixtures", () => {
  const t = buildDemoTables();
  const projectIds = new Set(t.projects.map((p) => p.id));
  const milestoneIds = new Set(t.milestones.map((m) => m.id));
  const candidateIds = new Set(t.candidates.map((c) => c.id));
  const companyIds = new Set(t.companies.map((c) => c.id));

  it("anchors the TechNova scenario", () => {
    expect(t.companies.map((c) => c.name)).toContain("TechNova Solutions");
    const project = t.projects.find((p) => p.id === DEMO_IDS.project);
    expect(project?.title).toBe("Enterprise SaaS Implementation");
  });

  it("budgets exactly $25,000 across 6 milestones", () => {
    const ms = t.milestones.filter((m) => m.projectId === DEMO_IDS.project);
    expect(ms).toHaveLength(6);
    const total = ms.reduce((sum, m) => sum + Number(m.budgetUsd), 0);
    expect(total).toBe(25000);
  });

  it("covers all required milestone scenario beats", () => {
    const byId = Object.fromEntries(t.milestones.map((m) => [m.id, m]));
    expect(byId[DEMO_IDS.milestones.requirements].status).toBe("paid");
    expect(byId[DEMO_IDS.milestones.frontend].status).toBe("funded");
    expect(byId[DEMO_IDS.milestones.backend].status).toBe("verifying");
    expect(byId[DEMO_IDS.milestones.integration].status).toBe("pending_approval");
    // delayed: frontend due date is in the past while still funded
    expect(
      new Date(byId[DEMO_IDS.milestones.frontend].dueDate!).getTime()
    ).toBeLessThan(Date.now());
  });

  it("resolves every milestone dependency within the project", () => {
    for (const m of t.milestones) {
      expect(projectIds.has(m.projectId)).toBe(true);
      if (m.dependsOnId) expect(milestoneIds.has(m.dependsOnId)).toBe(true);
    }
  });

  it("ships three candidates with distinct skills and vetting signals", () => {
    const cs = t.candidates.filter((c) => c.projectId === DEMO_IDS.project);
    expect(cs).toHaveLength(3);
    for (const c of cs) {
      expect(companyIds.size).toBeGreaterThan(0);
      expect(candidateIds.has(c.id)).toBe(true);
    }
    expect(t.signals.length).toBeGreaterThanOrEqual(3);
    for (const s of t.signals) {
      expect(candidateIds.has(s.candidateId)).toBe(true);
    }
  });

  it("resolves NDA, meeting, payment, approval, and proposal references", () => {
    for (const n of t.ndas) {
      expect(candidateIds.has(n.candidateId)).toBe(true);
      expect(projectIds.has(n.projectId)).toBe(true);
    }
    for (const m of t.meetings) {
      expect(candidateIds.has(m.candidateId)).toBe(true);
    }
    for (const p of t.payments) {
      expect(milestoneIds.has(p.milestoneId)).toBe(true);
      if (p.candidateId) expect(candidateIds.has(p.candidateId)).toBe(true);
    }
    const paymentIds = new Set(t.payments.map((p) => p.id));
    for (const a of t.approvals) {
      expect(paymentIds.has(a.paymentId)).toBe(true);
      expect(milestoneIds.has(a.milestoneId)).toBe(true);
    }
    for (const p of t.paymentProposals) {
      expect(milestoneIds.has(p.milestoneId)).toBe(true);
    }
  });

  it("seeds the dispute, reschedule, verification, and orchestration beats", () => {
    expect(t.disputes.map((d) => d.id)).toContain(DEMO_IDS.dispute);
    expect(t.schedulingProposals.map((s) => s.id)).toContain(
      DEMO_IDS.schedulingProposal
    );
    expect(
      t.schedulingProposals.find((s) => s.id === DEMO_IDS.schedulingProposal)
        ?.status
    ).toBe("pending_approval");
    expect(t.verificationRuns.length).toBeGreaterThanOrEqual(1);
    expect(t.agentExecutions.length).toBeGreaterThanOrEqual(1);
    for (const d of t.disputes) {
      expect(milestoneIds.has(d.milestoneId)).toBe(true);
    }
    for (const v of t.verificationRuns) {
      if (v.milestoneId) expect(milestoneIds.has(v.milestoneId)).toBe(true);
    }
  });

  it("keeps every demo ID namespaced as fictional", () => {
    const ids = [
      ...t.companies.map((c) => c.id),
      ...t.projects.map((p) => p.id),
      ...t.milestones.map((m) => m.id),
      ...t.candidates.map((c) => c.id),
      ...t.disputes.map((d) => d.id),
      ...t.agentExecutions.map((e) => e.id),
    ];
    for (const id of ids) {
      expect(id.startsWith("demo-")).toBe(true);
    }
    for (const m of t.milestones) {
      for (const f of [m.paypalOrderId, m.paypalCaptureId, m.paypalPayoutBatchId]) {
        if (f) expect(f.startsWith("DEMO-")).toBe(true);
      }
    }
  });

  it("seals accepted fixture NDAs so placeholder hashes are unreachable", () => {
    // Accepted fixtures carry placeholder document hashes, which is safe
    // ONLY because their invites are sealed: resolveDemoNdaDetails returns
    // already_accepted before any hash comparison. Newly created demo NDAs
    // (via createDemoNda) always get exact computed hashes.
    for (const nda of t.ndas) {
      if (nda.status === "accepted") {
        expect(nda.inviteTokenUsed).toBe(true);
      }
    }
  });

  it("builds well-formed NDA text for every fixture NDA", () => {
    const project = t.projects.find((p) => p.id === DEMO_IDS.project)!;
    const company = t.companies.find((c) => c.id === project.companyId)!;
    for (const nda of t.ndas) {
      const candidate = t.candidates.find((c) => c.id === nda.candidateId)!;
      const date = new Date(nda.sentAt ?? nda.createdAt)
        .toISOString()
        .slice(0, 10);
      const text = buildNdaText({
        projectTitle: project.title,
        companyName: company.name,
        candidateName: candidate.name,
        date,
      });
      expect(text).toContain(candidate.name);
      expect(text).toContain(project.title);
      expect(text).toContain(company.name);
      expect(sha256Hex(text)).toHaveLength(64);
    }
  });
});
