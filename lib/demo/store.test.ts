/**
 * Offline demo NDA invite-loop tests.
 *
 * Proves the full loop a judge walks in demo mode: generate an NDA for a
 * shortlisted candidate → issue a single-use invite link → open it → sign
 * with the exact document hash → acceptance recorded, candidate advanced.
 * Also proves single-use enforcement and hash binding.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDemoStore,
  getDemoTables,
  createDemoNda,
  issueDemoInvite,
  consumeDemoInvite,
  acceptDemoNda,
  demoNdaText,
} from "./store";
import { DEMO_IDS } from "./config";
import { sha256Hex } from "@/lib/nda/invite-token";

describe("demo NDA invite loop", () => {
  beforeEach(() => {
    resetDemoStore();
  });

  it("runs generate → invite → accept end to end", () => {
    const created = createDemoNda(
      DEMO_IDS.candidates.lena,
      DEMO_IDS.project
    );
    expect(created).not.toBeNull();

    const [ndaId, raw] = created!.invitePath
      .replace("/invite/", "")
      .split(":");
    expect(consumeDemoInvite(ndaId, raw)).toBe("ok");

    const text = demoNdaText(ndaId);
    expect(text).not.toBeNull();
    const outcome = acceptDemoNda(ndaId, raw, "Lena Fischer", sha256Hex(text!));
    expect(outcome).toBe("ok");

    const t = getDemoTables();
    expect(t.ndas.find((n) => n.id === ndaId)?.status).toBe("accepted");
    expect(
      t.candidates.find((c) => c.id === DEMO_IDS.candidates.lena)?.status
    ).toBe("nda_signed");
  });

  it("enforces single-use invites", () => {
    const created = createDemoNda(
      DEMO_IDS.candidates.lena,
      DEMO_IDS.project
    )!;
    const [ndaId, raw] = created.invitePath.replace("/invite/", "").split(":");
    const text = demoNdaText(ndaId)!;
    expect(acceptDemoNda(ndaId, raw, "Lena Fischer", sha256Hex(text))).toBe("ok");
    // Replay with the same token must fail.
    expect(acceptDemoNda(ndaId, raw, "Lena Fischer", sha256Hex(text))).toBe(
      "used"
    );
  });

  it("rejects tampered document hashes", () => {
    const created = createDemoNda(
      DEMO_IDS.candidates.lena,
      DEMO_IDS.project
    )!;
    const [ndaId, raw] = created.invitePath.replace("/invite/", "").split(":");
    expect(
      acceptDemoNda(ndaId, raw, "Lena Fischer", "0".repeat(64))
    ).toBe("hash_mismatch");
  });

  it("reissues links that invalidate the previous token", () => {
    const created = createDemoNda(
      DEMO_IDS.candidates.lena,
      DEMO_IDS.project
    )!;
    const [ndaId, firstRaw] = created.invitePath
      .replace("/invite/", "")
      .split(":");
    const reissued = issueDemoInvite(ndaId)!;
    const [, secondRaw] = reissued.invitePath.replace("/invite/", "").split(":");
    expect(consumeDemoInvite(ndaId, firstRaw)).toBe("invalid");
    expect(consumeDemoInvite(ndaId, secondRaw)).toBe("ok");
  });
});
