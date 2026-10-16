// Disable static pre-rendering: this page reads from the DB at request time.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { ndas, candidates, projects } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Demo Inbox — server component.
 *
 * Shows all pending NDA invite links in the system.
 * In a real app this would be filtered by the logged-in freelancer's email.
 * For the demo, all sent NDAs are visible here so the judge can act as any candidate.
 *
 * Phase 4: invite links are clickable → /invite/[token] NDA acceptance page.
 * The token in the URL is "ndaId:rawToken" — but raw tokens are NOT stored in DB,
 * so the audit_log entries from NDA generation contain the invite URL.
 * For demo we display the Phase 4 token-based links from audit_log.
 */
export default async function DemoInboxPage() {
  const pendingNdas = await db
    .select()
    .from(ndas)
    .where(eq(ndas.status, "sent"));

  // Fetch candidate names for display
  const candidateIds = pendingNdas.map((n) => n.candidateId);
  const candidateList =
    candidateIds.length > 0
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
  const projectList =
    projectIds.length > 0
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
            const isPhase4 = Boolean(nda.inviteTokenHash);

            return (
              <Card key={nda.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      {candidateName}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      {isPhase4 ? (
                        <Badge variant="default" className="text-xs">
                          Phase 4
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Legacy
                        </Badge>
                      )}
                      <Badge variant="outline">Pending</Badge>
                    </div>
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

                  <div className="rounded-lg border bg-muted p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Invite link:
                    </p>
                    {isPhase4 ? (
                      // Phase 4: token is in audit_log — show placeholder that navigates to demo
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          Token hash stored securely. In a real deployment, the
                          raw token is emailed. For demo, use the{" "}
                          <strong>Generate NDA</strong> API which returns the
                          full invite URL.
                        </p>
                        <p className="text-xs font-mono text-muted-foreground break-all">
                          Token hash: {nda.inviteTokenHash?.slice(0, 16)}…
                        </p>
                        {nda.inviteTokenExpiresAt && (
                          <p className="text-xs text-muted-foreground">
                            Token expires:{" "}
                            {new Date(nda.inviteTokenExpiresAt).toLocaleString("en-US", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </p>
                        )}
                      </div>
                    ) : (
                      // Legacy: inviteToken field (plain text)
                      nda.inviteToken ? (
                        <div className="space-y-1">
                          <Link
                            href={`/invite/${nda.id}:${nda.inviteToken}`}
                            className="text-xs text-blue-600 dark:text-blue-400 underline break-all"
                          >
                            /invite/{nda.id}:{nda.inviteToken.slice(0, 12)}…
                          </Link>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No invite token — NDA may need to be regenerated.
                        </p>
                      )
                    )}
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
