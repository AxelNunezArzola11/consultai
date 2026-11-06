/**
 * Project new page — start form, then split screen: chat (left) + plan canvas (right).
 *
 * URL: /project/new
 * Query params:
 *   ?projectId=<id>          — existing draft to open in the planner
 *   &brief=<urlencoded brief> — optional pre-fill for the planning chat
 *
 * Loading this page NEVER writes to the database. The draft row is created
 * only by POST /api/projects after the user submits the start form.
 */
export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NewProjectClient } from "./NewProjectClient";
import { NewProjectStartForm } from "./NewProjectStartForm";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; brief?: string }>;
}) {
  const { projectId, brief } = await searchParams;

  // No draft selected yet — show the start form (no DB writes).
  if (!projectId) {
    return <NewProjectStartForm />;
  }

  const draft = isDemoMode()
    ? (() => {
        const p = getDemoTables().projects.find((r) => r.id === projectId);
        return p ? { id: p.id, rawBrief: p.rawBrief } : undefined;
      })()
    : (
        await db
          .select({ id: projects.id, rawBrief: projects.rawBrief })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
      )[0];

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
      initialBrief={
        brief ? decodeURIComponent(brief) : (draft.rawBrief ?? undefined)
      }
      feePolicy={feePolicy}
    />
  );
}
