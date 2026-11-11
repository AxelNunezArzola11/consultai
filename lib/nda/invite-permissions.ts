/**
 * NDA invite-link issuance permission.
 *
 * Mirrors the server-side enforcement in POST /api/nda/generate and
 * POST /api/nda/regenerate (company or admin role only). The demo inbox
 * uses this to decide whether to render the "Issue invite link" control:
 * freelancers must never mint their own invitation links (that would
 * defeat the NDA flow), so they see guidance instead of a button that
 * would always 403.
 *
 * Client-safe: pure function, no imports.
 */

import type { Role } from "@/lib/auth/role-cookie";

export function canIssueNdaInviteLinks(role: Role | null): boolean {
  return role === "company" || role === "admin";
}
