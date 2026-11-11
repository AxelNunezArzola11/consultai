// Disable static pre-rendering: this page reads from the DB at request time.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { ndas, candidates, projects } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InviteLinkManager } from "./InviteLinkManager";
import { canIssueNdaInviteLinks } from "@/lib/nda/invite-permissions";
import { isDemoMode } from "@/lib/demo/config";
import { getDemoTables } from "@/lib/demo/store";
import { requirePageRole, candidateIdsForFreelancer } from "@/lib/auth/guards";
import { redirect } from "next/navigation";

/**
 * Demo Inbox — server component.
 *
 * Shows all pending NDA invitations in the system.
 * In a real app this would be filtered by the logged-in freelancer's email.
 * For the demo, all sent NDAs are visible here so the judge can act as any candidate.
 *
 * Raw invite tokens are never stored, so each card issues a fresh single-use
 * link on demand (company/admin role) via POST /api/nda/regenerate — shown
 * once to the operator. No token hashes are exposed as links.
 */
export default async function DemoInboxPage() {
  // Authenticate + authorize BEFORE querying/rendering (demo bypass: fixtures only).
  const auth = await requirePageRole(["company", "freelancer", "admin"]);
  if (!auth.demoBypass && !auth.session) {
    // Live session-less holder: no verified identity to scope invitations
    // to — re-authenticate instead of serving the unscoped inbox.
    redirect("/login");
  }
  const demoTables = isDemoMode() ? getDemoTables() : null;
  // Live NDA isolation: company sessions see their own projects' NDAs only;
  // freelancer sessions see their own candidacies' NDAs only; admin sees all.
  let pendingNdas: Array<typeof ndas.$inferSelect> = [];
  if (demoTables) {
    pendingNdas = demoTables.ndas.filter((n) => n.status === "sent");
  } else if (
    auth.session?.role === "company" &&
    auth.session.companyId &&
    !auth.demoBypass
  ) {
    const ownProjectIds = (
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.companyId, auth.session.companyId))
    ).map((r) => r.id);
    pendingNdas =
      ownProjectIds.length > 0
        ? await db
            .select()
            .from(ndas)
            .where(
              and(
                eq(ndas.status, "sent"),
                inArray(ndas.projectId, ownProjectIds)
              )
            )
        : [];
  } else if (auth.session?.role === "freelancer" && !auth.demoBypass) {
    const assigned = await candidateIdsForFreelancer(auth);
    pendingNdas =
      assigned === null
        ? await db.select().from(ndas).where(eq(ndas.status, "sent"))
        : assigned.length > 0
          ? await db
              .select()
              .from(ndas)
              .where(
                and(
                  eq(ndas.status, "sent"),
                  inArray(ndas.candidateId, assigned)
                )
              )
          : [];
  } else if (!demoTables) {
    pendingNdas = await db.select().from(ndas).where(eq(ndas.status, "sent"));
  }

  // Fetch candidate names for display
  const candidateIds = pendingNdas.map((n) => n.candidateId);
  const candidateList = demoTables
    ? demoTables.candidates
        .filter((c) => candidateIds.includes(c.id))
        .map((c) => ({ id: c.id, name: c.name }))
    : candidateIds.length > 0
      ? await db
          .select({ id: candidates.id, name: candidates.name })
          .from(candidates)
          .where(inArray(candidates.id, candidateIds))
      : [];

  const candidateMap = Object.fromEntries(
    candidateList.map((c) => [c.id, c.name])
  );

  // Fetch project titles
  const projectIds = [...new Set(pendingNdas.map((n) => n.projectId))];
  const projectList = demoTables
    ? demoTables.projects
        .filter((p) => projectIds.includes(p.id))
        .map((p) => ({ id: p.id, title: p.title }))
    : projectIds.length > 0
      ? await db
          .select({ id: projects.id, title: projects.title })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : [];

  const projectMap = Object.fromEntries(
    projectList.map((p) => [p.id, p.title])
  );

  return (
    <div className="px-6 py-8 max-w-2xl mx-auto w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Demo Inbox</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Pending NDA invitations — click an invite link to accept as that
          candidate.{" "}
          <span className="font-medium text-amber-600">
            For demo purposes only — all invitations are visible here.
          </span>
        </p>
      </div>

      <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
        <strong>Demo note:</strong> In production, each candidate would receive
        a private email. Here, all invite links are shown for judge convenience.
        Invite links use a secure 128-bit random token — only the SHA-256 hash
        is stored in the database.
      </div>

      {pendingNdas.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No pending NDA invitations.{" "}
            <span className="text-xs">
              Use the{" "}
              <Link
                href="/dashboard"
                className="underline text-foreground"
              >
                dashboard
              </Link>{" "}
              or POST to{" "}
              <code className="bg-muted px-1 rounded">/api/nda/generate</code>{" "}
              to create invitations.
            </span>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {pendingNdas.map((nda) => {
            const candidateName = candidateMap[nda.candidateId] ?? nda.candidateId;
            const projectTitle = projectMap[nda.projectId] ?? nda.projectId;

            return (
              <Card key={nda.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      {candidateName}
                    </CardTitle>
                    <Badge variant="outline">Pending</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Project: {projectTitle}
                  </p>
                </CardHeader>
                <CardContent className="text-sm space-y-3">
                  {nda.expiresAt && (
                    <p className="text-muted-foreground text-xs">
                      NDA expires:{" "}
                      {new Date(nda.expiresAt).toLocaleString("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                  )}

                  <div className="rounded-lg border bg-muted p-3">
                    <InviteLinkManager
                      ndaId={nda.id}
                      canIssue={canIssueNdaInviteLinks(auth.role)}
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
