import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

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

import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import {
  getPageAuth,
  requirePageRole,
  requireProjectAccess,
  scopedCompanyId,
  isRoleAllowed,
  roleHome,
  type PageAuth,
} from "./guards";

function mockCookies(header: string | null) {
  const pairs =
    header
      ?.split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const eq = c.indexOf("=");
        return { name: c.slice(0, eq), value: c.slice(eq + 1) };
      }) ?? [];
  vi.mocked(cookies).mockResolvedValue({
    getAll: () => pairs,
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

describe("page guards (lib/auth/guards)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEMO_MODE = "false";
    process.env.ROLE_COOKIE_SECRET =
      "test-role-secret-0123456789abcdef-test";
    process.env.SESSION_COOKIE_SECRET =
      "test-session-secret-0123456789abcdef-test12";
  });

  it("maps roles to homes and checks membership (pure)", () => {
    expect(roleHome("company")).toBe("/dashboard");
    expect(roleHome("freelancer")).toBe("/freelancer");
    expect(roleHome("admin")).toBe("/admin");
    expect(isRoleAllowed("company", ["company", "admin"])).toBe(true);
    expect(isRoleAllowed("freelancer", ["company", "admin"])).toBe(false);
    expect(isRoleAllowed(null, ["company", "admin"])).toBe(false);
  });

  it("scopes company sessions, unscoped admin/session-less, demo-only company-1 bypass (pure)", () => {
    const company = (companyId: string | null, demoBypass: boolean): PageAuth => ({
      session: {
        sessionId: "s",
        userId: "u",
        email: "e",
        name: "n",
        role: "company",
        companyId,
        companyName: null,
        githubHandle: null,
        isAuthenticatedUser: true,
      },
      role: "company",
      demoBypass,
    });
    expect(scopedCompanyId(company("company-9", false))).toBe("company-9");
    expect(scopedCompanyId(company("company-1", false))).toBe("company-1");
    expect(scopedCompanyId(company("company-1", true))).toBeNull();
    expect(scopedCompanyId(company("company-9", true))).toBe("company-9");
    expect(
      scopedCompanyId({ session: null, role: "company", demoBypass: false })
    ).toBeNull();
    expect(
      scopedCompanyId({ session: null, role: "admin", demoBypass: false })
    ).toBeNull();
  });

  it("redirects unauthenticated live callers to /login", async () => {
    mockCookies(null);
    const auth = await getPageAuth();
    expect(auth.role).toBeNull();
    await expect(requirePageRole(["company", "admin"])).rejects.toThrow(
      "NEXT_REDIRECT:/login"
    );
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("redirects wrong-role live callers to their role home", async () => {
    const { signRoleCookie } = await import("./role-cookie");
    const setCookie = await signRoleCookie("freelancer");
    mockCookies(setCookie.split(";")[0]);
    const auth = await getPageAuth();
    expect(auth.role).toBe("freelancer");
    await expect(requirePageRole(["company", "admin"])).rejects.toThrow(
      "NEXT_REDIRECT:/freelancer"
    );
    expect(redirect).toHaveBeenCalledWith("/freelancer");
  });

  it("allows the right role cookie in live mode without redirect", async () => {
    const { signRoleCookie } = await import("./role-cookie");
    const setCookie = await signRoleCookie("admin");
    mockCookies(setCookie.split(";")[0]);
    const auth = await requirePageRole(["admin"]);
    expect(auth.role).toBe("admin");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects session-less company holders to /login in live mode (D.3)", async () => {
    const { signRoleCookie } = await import("./role-cookie");
    const setCookie = await signRoleCookie("company");
    mockCookies(setCookie.split(";")[0]);
    const auth = await getPageAuth();
    expect(auth.role).toBe("company");
    expect(auth.session).toBeNull();
    await expect(requirePageRole(["company", "admin"])).rejects.toThrow(
      "NEXT_REDIRECT:/login"
    );
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("bypasses enforcement in demo mode even with no cookies", async () => {
    process.env.DEMO_MODE = "true";
    mockCookies(null);
    const auth = await requirePageRole(["admin"]);
    expect(auth.demoBypass).toBe(true);
    expect(auth.role).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
    const proj = await requireProjectAccess("demo-project-saas");
    expect(proj.demoBypass).toBe(true);
    expect(notFound).not.toHaveBeenCalled();
  });
});
