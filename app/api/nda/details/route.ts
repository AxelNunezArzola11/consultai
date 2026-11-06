/**
 * GET /api/nda/details?token=ndaId:rawToken
 *
 * Returns the invitation data a candidate needs BEFORE signing: real project,
 * company, and candidate names plus the exact NDA document text (whose SHA-256
 * must match the stored hash for /api/nda/accept to succeed).
 *
 * Never returns the full brief, token material, or hashes. Distinct error
 * codes let the invite page explain expired/used/invalid states honestly.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveNdaDetails } from "@/lib/nda/details";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json(
      { error: "invalid_or_expired_token" },
      { status: 404 }
    );
  }

  const result = await resolveNdaDetails(token);
  if (!result.ok) {
    const status =
      result.error === "token_expired"
        ? 410
        : result.error === "already_used" ||
          result.error === "already_accepted"
        ? 409
        : result.error === "rate_limited"
        ? 429
        : result.error === "reconstruction_failed"
        ? 500
        : 404;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ status: "ok", ...result.details });
}
