// Disable static pre-rendering: this page reads from the DB at request time.
export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { ndas, candidates } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Demo Inbox — server component.
 *
 * Shows all pending NDA invite links in the system.
 * In a real app, this would be filtered by the logged-in freelancer's email.
 * For the demo, all sent NDAs are visible here so the judge can act as any candidate.
 *
 * Phase 0: read-only list with copyable invite links.
 * Phase 4 will add: NDA acceptance flow at /invite/[token].
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

      {pendingNdas.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No pending NDA invitations.{" "}
            <span className="text-xs">
              Run <code className="bg-muted px-1 rounded">npm run seed</code>{" "}
              to load demo data.
            </span>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {pendingNdas.map((nda) => (
            <Card key={nda.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    NDA Invitation for{" "}
                    {candidateMap[nda.candidateId] ?? nda.candidateId}
                  </CardTitle>
                  <Badge variant="outline">Pending</Badge>
                </div>
              </CardHeader>
              <CardContent className="text-sm space-y-3">
                {nda.expiresAt && (
                  <p className="text-muted-foreground text-xs">
                    Expires:{" "}
                    {new Date(nda.expiresAt).toLocaleString("en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                )}

                {nda.inviteToken ? (
                  <div className="rounded-lg border bg-muted p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Invite link (copyable):
                    </p>
                    <code className="text-xs break-all">
                      {/* Phase 4 will render this as a real link to /invite/[token] */}
                      /invite/{nda.inviteToken}
                    </code>
                    <p className="text-xs text-amber-600">
                      ⚠️ /invite/[token] page not yet built (Phase 4)
                    </p>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    No invite token — NDA may need to be regenerated.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
