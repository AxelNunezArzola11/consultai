/**
 * Page-layer authorization regression tests (lib/auth/guards).
 *
 * Route handlers are not the only private-data surface: server pages and
 * layouts must also reject unauthorized callers FIRST, before any query or
 * render. These tests pin requireProjectAccess / requirePageRole:
 * unauthenticated live callers redirect to /login, wrong-role callers
 * redirect to their role home, and cross-company / missing project access
 * resolves to notFound() (non-disclosing for reads).
 *
 * Unit-level with mocked next/headers, next/navigation, session, role, and
 * db modules — no live DB, no real navigation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    const err = new Error("NEXT_NOT_FOUND") as Error & { digest: string };
    err.digest = "NEXT_NOT_FOUND";
    throw err;
  }),
}));
vi.mock("./session", () => ({ getSessionFromCookie: vi.fn() }));
vi.mock("./role-cookie", () => ({ getRoleFromCookie: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));

import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getSessionFromCookie } from "./session";
import { getRoleFromCookie } from "./role-cookie";
import { db } from "@/lib/db";
import { requirePageRole, requireProjectAccess } from "./guards";

const mockedCookies = vi.mocked(cookies);
const mockedGetSession = vi.mocked(getSessionFromCookie);
const mockedGetRole = vi.mocked(getRoleFromCookie);
const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;

function mockCookies(header: string | null): void {
  const pairs =
    header
      ?.split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const eq = c.indexOf("=");
        return { name: c.slice(0, eq), value: c.slice(eq + 1) };
      }) ?? [];
  mockedCookies.mockResolvedValue({
    getAll: () => pairs,
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

function mockProjectRows(rows: Array<{ companyId: string }>): void {
  selectMock.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  });
}

function companySession(companyId: string | null) {
  return {
    sessionId: "sess-1",
    userId: "user-1",
    email: "owner@consultai.test",
    name: "Owner",
    role: "company" as const,
    companyId,
    companyName: "Synthetic Co",
    githubHandle: null,
    isAuthenticatedUser: true,
  };
}

describe("page guards reject unauthorized callers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEMO_MODE = "false";
    mockCookies("consultai_session_v1=synthetic");
    mockedGetSession.mockResolvedValue(null);
    mockedGetRole.mockResolvedValue(null);
  });

  it("unauthenticated live caller is redirected to /login", async () => {
    await expect(requirePageRole(["company", "admin"])).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("wrong-role caller is redirected to their role home (no data leak)", async () => {
    mockedGetSession.mockResolvedValue({
      ...companySession(null),
      role: "freelancer",
      companyId: null,
    });
    await expect(requirePageRole(["company", "admin"])).rejects.toThrow(
      "NEXT_REDIRECT:/freelancer"
    );
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("session-less company holder is redirected to /login (D.3, no DB touch)", async () => {
    mockedGetSession.mockResolvedValue(null);
    mockedGetRole.mockResolvedValue("company");
    await expect(requirePageRole(["company", "admin"])).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("cross-company project page access → notFound (non-disclosing)", async () => {
    mockedGetSession.mockResolvedValue(companySession("company-a"));
    mockProjectRows([{ companyId: "company-b" }]);
    await expect(requireProjectAccess("proj-beta-owned")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("missing project page access → notFound", async () => {
    mockedGetSession.mockResolvedValue(companySession("company-a"));
    mockProjectRows([]);
    await expect(requireProjectAccess("proj-missing")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("own-company project page access passes and returns the auth", async () => {
    mockedGetSession.mockResolvedValue(companySession("company-a"));
    mockProjectRows([{ companyId: "company-a" }]);
    const auth = await requireProjectAccess("proj-alpha-owned");
    expect(auth.role).toBe("company");
    expect(auth.session?.companyId).toBe("company-a");
  });

  it("admin project page access passes without a company-scope DB check", async () => {
    mockedGetSession.mockResolvedValue({
      ...companySession(null),
      role: "admin",
      email: "admin@consultai.test",
    });
    const auth = await requireProjectAccess("proj-any");
    expect(auth.role).toBe("admin");
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("demo mode bypasses enforcement for fixture walkthroughs (no DB touch)", async () => {
    process.env.DEMO_MODE = "true";
    try {
      mockedGetSession.mockResolvedValue(companySession("company-1"));
      const auth = await requireProjectAccess(DEMO_BYPASS_PROJECT);
      expect(auth.demoBypass).toBe(true);
      expect(selectMock).not.toHaveBeenCalled();
    } finally {
      process.env.DEMO_MODE = "false";
    }
  });
});

const DEMO_BYPASS_PROJECT = "demo-project-saas";
