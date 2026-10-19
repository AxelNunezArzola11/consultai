/**
 * POST /api/candidates
 *
 * Creates a new candidate for a project, then immediately records consent
 * and kicks off the vetting pipeline.
 *
 * Body:
 *   {
 *     projectId:    string  — must belong to the company
 *     githubHandle: string  — GitHub username (required; drives the analysis)
 *     name?:        string  — display name (defaults to "@githubHandle")
 *     email?:       string  — contact email (defaults to placeholder)
 *   }
 *
 * Returns: the created candidate id so the client can call the vetting route.
 *
 * Auth: company role cookie required.
 * Validation: Zod.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { candidates, projects } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  projectId:    z.string().min(1).max(100),
  githubHandle: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/, "Invalid GitHub handle"),
  name:  z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company") {
    return NextResponse.json({ error: "Forbidden: company role required" }, { status: 403 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { projectId, githubHandle, name, email } = parsed.data;

  // Verify project exists
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Check for duplicate github handle in this project
  const [existing] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(eq(candidates.githubHandle, githubHandle))
    .limit(1);

  if (existing) {
    // Return the existing id so the client can proceed to vetting without a duplicate
    return NextResponse.json({ id: existing.id, alreadyExists: true });
  }

  const id = nanoid();
  const displayName  = name  ?? `@${githubHandle}`;
  const displayEmail = email ?? `${githubHandle}@github.placeholder`;

  await db.insert(candidates).values({
    id,
    projectId,
    name:         displayName,
    email:        displayEmail,
    githubHandle,
    status:       "pending",
    // Record consent at creation time — the company is adding this candidate
    // and consenting on their behalf for the purpose of portfolio analysis.
    // This mirrors the existing "Record Consent + Run Vetting" button flow.
    vettingConsentAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return NextResponse.json({ id, alreadyExists: false }, { status: 201 });
}
