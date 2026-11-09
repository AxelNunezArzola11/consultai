/**
 * Regression tests for the /project/new planner page (demo mode).
 *
 * The creation form navigates here with the POST-accepted params
 * (?projectId=&title=&brief=). Next.js already percent-decodes searchParams,
 * so the page must use the brief verbatim — decoding it a second time throws
 * "URI malformed" for any realistic brief containing "%" (e.g. "cut costs by
 * 20%") and breaks step 2 of project creation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth/guards", () => ({
  requirePageRole: vi.fn(async () => ({
    session: null,
    role: "company",
    demoBypass: true,
  })),
  scopedCompanyId: vi.fn(() => null),
}));

import NewProjectPage from "./page";
import { resetDemoStore } from "@/lib/demo/store";

describe("/project/new planner params", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetDemoStore();
  });

  it("brief containing % renders verbatim (no double-decode crash)", async () => {
    const brief = "Cut cloud costs by 20% and ship 2x faster";
    const el = (await NewProjectPage({
      searchParams: Promise.resolve({
        projectId: "new-page-pct-brief",
        title: "Percent Brief Project",
        brief,
      }),
    })) as unknown as { props: { initialBrief?: string; initialTitle?: string } };

    expect(el.props.initialBrief).toBe(brief);
    expect(el.props.initialTitle).toBe("Percent Brief Project");
  });

  it("falls back to the stored draft brief when the URL carries none", async () => {
    const { resolveDemoDraftForPlanning, demoCompanyForSession } =
      await import("@/lib/demo/drafts");
    resolveDemoDraftForPlanning({
      projectId: "new-page-stored-brief",
      title: "Stored Brief Project",
      brief: "Lift conversion by 15% in Q3",
      companyId: demoCompanyForSession(undefined),
    });

    const el = (await NewProjectPage({
      searchParams: Promise.resolve({
        projectId: "new-page-stored-brief",
        title: "Stored Brief Project",
      }),
    })) as unknown as { props: { initialBrief?: string } };

    expect(el.props.initialBrief).toBe("Lift conversion by 15% in Q3");
  });
});
