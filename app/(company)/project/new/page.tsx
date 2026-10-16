/**
 * Project new page — split screen: chat (left) + plan canvas (right).
 *
 * Server component that creates a new draft project row and passes IDs to
 * the client split-screen layout.
 *
 * URL: /project/new
 * Query params:
 *   ?brief=<urlencoded brief text>  — optional pre-fill from "new project" form
 */
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { cookies } from "next/headers";
import { NewProjectClient } from "./NewProjectClient";

async function createDraftProject(companyId: string): Promise<string> {
  const id = nanoid();
  await db.insert(projects).values({
    id,
    companyId,
    title: "New project",
    status: "draft",
  });
  return id;
}

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ brief?: string }>;
}) {
  const { brief } = await searchParams;

  // Demo: resolve companyId from role cookie or use seeded company
  const cookieStore = await cookies();
  const _ = cookieStore; // accessed to silence unused warning
  const companyId = "company-1"; // seeded company

  const projectId = await createDraftProject(companyId);

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
      projectId={projectId}
      initialBrief={brief ? decodeURIComponent(brief) : undefined}
      feePolicy={feePolicy}
    />
  );
}
