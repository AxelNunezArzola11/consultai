/**
 * Freelancer assignment identity tests (lib/auth/guards).
 *
 * Pins that assignment resolution derives identity ONLY from the
 * authenticated session (email / githubHandle): session-less callers and
 * sessions without identity resolve to zero assignments (fail closed, never
 * unscoped reads), and candidate matching is exact on the session identity.
 *
 * Runs with a mocked @/lib/db: no DATABASE_URL, no Production data.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

import { db } from "@/lib/db";
import {
  candidateIdsForFreelancer,
  type PageAuth,
} from "./guards";
import type { SessionInfo } from "./session";

const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;

type CandidateRow = {
  id: string;
  email: string;
  githubHandle: string | null;
  projectId: string;
};

let candidateRows: CandidateRow[] = [];

function freelancerSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "sess-test-1",
    userId: "user-test-1",
    email: "dev@consultai.test",
    name: "Test Dev",
    role: "freelancer",
    companyId: null,
    companyName: null,
    githubHandle: null,
    isAuthenticatedUser: true,
    ...overrides,
  };
}

function authWith(session: SessionInfo | null): PageAuth {
  return {
    session,
    role: session?.role ?? "freelancer",
    demoBypass: false,
  };
}

describe("candidateIdsForFreelancer identity resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    candidateRows = [];
    selectMock.mockReturnValue({
      from: () => ({ where: async () => candidateRows }),
    });
  });

  it("session-less caller resolves to zero assignments without touching the DB", async () => {
    const ids = await candidateIdsForFreelancer({
      session: null,
      role: "freelancer",
      demoBypass: false,
    });
    expect(ids).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("session-less caller with no role resolves to zero assignments", async () => {
    const ids = await candidateIdsForFreelancer({
      session: null,
      role: null,
      demoBypass: false,
    });
    expect(ids).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("freelancer session without email or github handle → [] (no silent skip)", async () => {
    const ids = await candidateIdsForFreelancer(
      authWith(freelancerSession({ email: "", githubHandle: null }))
    );
    expect(ids).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("whitespace-only identity still resolves to []", async () => {
    const ids = await candidateIdsForFreelancer(
      authWith(freelancerSession({ email: "   ", githubHandle: "  " }))
    );
    expect(ids).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("admin and demo callers keep the explicit unrestricted null", async () => {
    await expect(
      candidateIdsForFreelancer({ session: null, role: "admin", demoBypass: false })
    ).resolves.toBeNull();
    await expect(
      candidateIdsForFreelancer({ session: null, role: null, demoBypass: true })
    ).resolves.toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("authenticated company session keeps the legacy null (scoped elsewhere)", async () => {
    const company = freelancerSession({
      role: "company",
      companyId: "company-1",
    });
    await expect(
      candidateIdsForFreelancer({
        session: company,
        role: "company",
        demoBypass: false,
      })
    ).resolves.toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("matches candidates by session email only (case-insensitive)", async () => {
    candidateRows = [
      { id: "c1", email: "DEV@consultai.test", githubHandle: null, projectId: "p1" },
      { id: "c2", email: "stranger@consultai.test", githubHandle: null, projectId: "p1" },
    ];
    const ids = await candidateIdsForFreelancer(
      authWith(freelancerSession({ email: "dev@consultai.test" }))
    );
    expect(ids).toEqual(["c1"]);
  });

  it("matches candidates by session github handle when email differs", async () => {
    candidateRows = [
      { id: "c1", email: "other@consultai.test", githubHandle: "DevHandle", projectId: "p1" },
      { id: "c2", email: "stranger@consultai.test", githubHandle: "stranger", projectId: "p1" },
    ];
    const ids = await candidateIdsForFreelancer(
      authWith(
        freelancerSession({ email: "nobody@consultai.test", githubHandle: "devhandle" })
      )
    );
    expect(ids).toEqual(["c1"]);
  });

  it("matches by either identity signal and ignores non-matching rows", async () => {
    candidateRows = [
      { id: "c1", email: "dev@consultai.test", githubHandle: null, projectId: "p1" },
      { id: "c2", email: "other@consultai.test", githubHandle: "devhandle", projectId: "p1" },
      { id: "c3", email: "stranger@consultai.test", githubHandle: "stranger", projectId: "p1" },
    ];
    const ids = await candidateIdsForFreelancer(
      authWith(
        freelancerSession({ email: "dev@consultai.test", githubHandle: "devhandle" })
      )
    );
    expect(ids).toEqual(["c1", "c2"]);
  });

  it("no matching rows → [] (honest empty state, not an error)", async () => {
    candidateRows = [
      { id: "c9", email: "stranger@consultai.test", githubHandle: "stranger", projectId: "p1" },
    ];
    const ids = await candidateIdsForFreelancer(
      authWith(freelancerSession({ email: "dev@consultai.test" }))
    );
    expect(ids).toEqual([]);
  });
});
