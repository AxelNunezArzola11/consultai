/**
 * Project new page — start form, then split screen: chat (left) + plan canvas (right).
 *
 * URL: /project/new
 * Query params:
 *   ?projectId=<id>          — existing draft to open in the planner
 *   &title=<title>            — creation title (demo rehydration, see below)
 *   &brief=<urlencoded brief> — optional pre-fill for the planning chat
 *
 * Loading this page NEVER writes to the database. The draft row is created
 * only by POST /api/projects after the user submits the start form.
 *
 * Demo rehydration: the demo store is per server instance, but serverless
 * routing can send the planner GET to an instance that never saw the POST.
 * In demo mode only, a lookup miss carrying the POST-accepted creation
 * params restores that same draft into the local instance store
 * (resolveDemoDraftForPlanning) instead of reporting "not found". Bare or
 * invalid IDs still miss, and the company scope check below still applies.
 */
export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NewProjectClient } from "./NewProjectClient";
import { NewProjectStartForm } from "./NewProjectStartForm";
import { isDemoMode } from "@/lib/demo/config";
import {
  demoCompanyForSession,
  resolveDemoDraftForPlanning,
} from "@/lib/demo/drafts";
import { requirePageRole, scopedCompanyId } from "@/lib/auth/guards";
import { notFound } from "next/navigation";

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; title?: string; brief?: string }>;
}) {
  const { projectId, title, brief } = await searchParams;
  // Authenticate + authorize BEFORE querying/rendering (demo bypass: fixtures only).
  const auth = await requirePageRole(["company", "admin"]);
  const scope = scopedCompanyId(auth);

  // No draft selected yet — show the start form (no DB writes).
  if (!projectId) {
    return <NewProjectStartForm />;
  }

  const draft = isDemoMode()
    ? (() => {
        // Owning company derived server-side exactly like POST /api/projects.
        // Never from the URL — links cannot spoof ownership.
        const companyId = demoCompanyForSession(auth.session?.companyId);
        return resolveDemoDraftForPlanning({
          projectId,
          title,
          brief,
          companyId,
        });
      })()
    : (
        await db
          .select({
            id: projects.id,
            title: projects.title,
            rawBrief: projects.rawBrief,
            companyId: projects.companyId,
          })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
      )[0];

  // Live company sessions open their own drafts only (non-disclosing).
  if (!auth.demoBypass && scope && draft && draft.companyId !== scope) {
    notFound();
  }

  if (!draft) {
    return (
      <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-6 text-center">
          <h1 className="text-lg font-bold text-white">
            Draft project not found
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            This planning link points to a project that does not exist. Start a
            new project to create a fresh draft.
          </p>
          <Link
            href="/project/new"
            className="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
          >
            Start a new project
          </Link>
        </div>
      </div>
    );
  }

  // Fee policy from env (server-side — safe to pass to client as plain props)
  const feePolicy = {
    captureFeeFraction: 0.132,
    payoutFeeUsd: 0.25,
    displayPolicy: (process.env.FEE_DISPLAY_POLICY ?? "SHOW_FEE") as
      | "GROSS_ONLY"
      | "SHOW_FEE"
      | "COMPANY_ABSORBS",
  };

  return (
    <NewProjectClient
      projectId={draft.id}
      // searchParams arrive percent-decoded from Next — use verbatim.
      // Decoding again throws "URI malformed" on realistic briefs with "%".
      initialBrief={brief ? brief : (draft.rawBrief ?? undefined)}
      initialTitle={draft.title ?? title ?? undefined}
      feePolicy={feePolicy}
    />
  );
}
