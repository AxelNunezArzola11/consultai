/**
 * POST /api/projects/[id]/milestones/reorder
 *
 * Reschedules a milestone's start_date and due_date after a Gantt task drop.
 *
 * Safety invariants:
 *   - Company role cookie required (role === "company")
 *   - Input validated with Zod (milestoneId, newStartDate, expectedVersion)
 *   - Funded / in-payout / paid milestones are REJECTED (cannot move money-locked tasks)
 *   - dependsOnId + offsetDays constraints are validated: if the milestone has a
 *     dependency, the new start_date must be ≥ dependency.due_date + 1 day
 *   - Optimistic concurrency: WHERE id = ? AND version = expectedVersion
 *     → 0 rows updated → 409 Conflict (stale read — client must refresh)
 *   - All dates stored as date-only strings "YYYY-MM-DD" (UTC, no timezone drift)
 *   - Every write is recorded in audit_log
 *
 * UTC date handling:
 *   Bryntum sends startDate as an ISO datetime (e.g. "2025-08-01T00:00:00").
 *   We strip the time part and validate the result is a valid YYYY-MM-DD string.
 *   All arithmetic uses T00:00:00Z to avoid DST / timezone off-by-one errors.
 *   The due_date is recalculated by the dependency engine after the start_date changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { milestones } from "@/lib/db/schema";
import { getRoleFromCookie } from "@/lib/auth/role-cookie";
import { writeAuditLog } from "@/lib/db/audit";
import { isFunded, addDays } from "@/lib/scheduling/dependency-engine";

export const dynamic = "force-dynamic";

// ── Statuses that lock a milestone against rescheduling ───────────────────────
const LOCKED_STATUSES = new Set([
  "funded",
  "submitted",
  "verifying",
  "pending_approval",
  "paid",
  "disputed",
  "cancelled",
]);

// ── ISO date-only helper ──────────────────────────────────────────────────────

/**
 * Normalise an ISO string from Bryntum to a date-only "YYYY-MM-DD" string.
 * Bryntum may send "2025-08-01T00:00:00" or "2025-08-01". We strip the time
 * component and validate the result is a real calendar date.
 * All arithmetic uses T00:00:00Z to pin to UTC midnight.
 */
function toDateOnly(raw: string): string | null {
  // Accept "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS[Z]" forms
  const dateOnly = raw.split("T")[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
  // Validate as a real date via UTC parse
  const ts = Date.UTC(
    parseInt(dateOnly.slice(0, 4), 10),
    parseInt(dateOnly.slice(5, 7), 10) - 1,
    parseInt(dateOnly.slice(8, 10), 10)
  );
  if (isNaN(ts)) return null;
  // Round-trip to confirm no overflow (e.g. Feb 30)
  const d = new Date(ts);
  const roundTrip = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return roundTrip === dateOnly ? dateOnly : null;
}

// ── Zod schema ─────────────────────────────────────────────────────────────────

const ReorderBodySchema = z.object({
  milestoneId: z
    .string()
    .min(1)
    .max(100),
  /** ISO date string — may include a time component; time is stripped server-side */
  newStartDate: z
    .string()
    .min(1)
    .max(30),
  /**
   * Optimistic concurrency: the client sends the version it last read.
   * If the DB row has a different version, reject with 409.
   * Optional — defaults to 0 so existing clients (pre-version) still work for
   * their first drop, but any subsequent drop requires the correct version.
   */
  expectedVersion: z.number().int().nonnegative().optional().default(0),
});

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const role = await getRoleFromCookie(req.headers.get("cookie"));
  if (role !== "company") {
    return NextResponse.json({ error: "Forbidden: company role required" }, { status: 403 });
  }

  // ── Project ID from path ─────────────────────────────────────────────────
  const { id: projectId } = await params;

  // ── Body validation ──────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ReorderBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { milestoneId, newStartDate: rawStartDate, expectedVersion } = parsed.data;

  // ── Normalise date to YYYY-MM-DD (UTC) ───────────────────────────────────
  const newStartDate = toDateOnly(rawStartDate);
  if (!newStartDate) {
    return NextResponse.json(
      { error: `newStartDate "${rawStartDate}" is not a valid calendar date` },
      { status: 400 }
    );
  }

  // ── Load the milestone ───────────────────────────────────────────────────
  const [milestone] = await db
    .select()
    .from(milestones)
    .where(
      and(
        eq(milestones.id, milestoneId),
        eq(milestones.projectId, projectId)
      )
    )
    .limit(1);

  if (!milestone) {
    return NextResponse.json(
      { error: "Milestone not found in this project" },
      { status: 404 }
    );
  }

  // ── Funded / locked status guard ─────────────────────────────────────────
  if (LOCKED_STATUSES.has(milestone.status) || isFunded(milestone.status)) {
    return NextResponse.json(
      {
        error: `Cannot reschedule milestone in status "${milestone.status}". ` +
          "Funded, in-payout, paid, and disputed milestones are protected from rescheduling.",
        status: milestone.status,
        milestoneId,
      },
      { status: 409 }
    );
  }

  // ── Dependency constraint validation ────────────────────────────────────
  // If this milestone depends on another, the new start_date must be
  // ≥ dependency.due_date + 1 day (start cannot precede dependency completion).
  if (milestone.dependsOnId) {
    const [dependency] = await db
      .select({ id: milestones.id, dueDate: milestones.dueDate, status: milestones.status })
      .from(milestones)
      .where(eq(milestones.id, milestone.dependsOnId))
      .limit(1);

    if (dependency?.dueDate) {
      // Earliest allowed start = dependency due_date + 1 day
      const earliestStart = addDays(dependency.dueDate, 1);
      if (newStartDate < earliestStart) {
        return NextResponse.json(
          {
            error: `New start_date (${newStartDate}) violates dependency constraint. ` +
              `Milestone depends on "${dependency.id}" which is due on ${dependency.dueDate}. ` +
              `Earliest allowed start_date is ${earliestStart}.`,
            earliestStart,
            dependsOnId: milestone.dependsOnId,
            dependencyDueDate: dependency.dueDate,
          },
          { status: 409 }
        );
      }
    }
  }

  // ── Recalculate due_date from new start_date + offsetDays ────────────────
  // due_date = newStartDate + offsetDays (if offsetDays is set).
  // If no offsetDays, keep the existing due_date; it is independent.
  let newDueDate: string | null = milestone.dueDate ?? null;
  if (milestone.offsetDays != null && milestone.dependsOnId) {
    // offsetDays is relative to the *dependency's* due_date, not start_date.
    // Load the parent to recompute.
    const [parent] = await db
      .select({ dueDate: milestones.dueDate })
      .from(milestones)
      .where(eq(milestones.id, milestone.dependsOnId))
      .limit(1);
    if (parent?.dueDate) {
      newDueDate = addDays(parent.dueDate, milestone.offsetDays);
    }
  } else if (milestone.offsetDays != null) {
    // offsetDays relative to start_date when no dependency
    newDueDate = addDays(newStartDate, milestone.offsetDays);
  }

  // ── Optimistic concurrency write ─────────────────────────────────────────
  // UPDATE ... WHERE id = ? AND version = expectedVersion
  // If 0 rows updated: stale read — someone else moved the task first.
  const updated = await db
    .update(milestones)
    .set({
      startDate: newStartDate,
      dueDate:   newDueDate ?? milestone.dueDate,
      version:   expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(milestones.id, milestoneId),
        eq(milestones.version, expectedVersion)
      )
    )
    .returning({ id: milestones.id, version: milestones.version });

  if (updated.length === 0) {
    return NextResponse.json(
      {
        error: "Optimistic concurrency conflict. The milestone was modified by another user. " +
          "Please refresh and try again.",
        expectedVersion,
      },
      { status: 409 }
    );
  }

  const newVersion = updated[0].version;

  // ── Audit log ─────────────────────────────────────────────────────────────
  await writeAuditLog({
    entityType: "milestone",
    entityId:   milestoneId,
    event:      "MILESTONE_RESCHEDULED",
    actor:      "company",
    payload: {
      projectId,
      newStartDate,
      newDueDate,
      previousStartDate: milestone.startDate ?? null,
      previousDueDate:   milestone.dueDate ?? null,
      previousVersion:   expectedVersion,
      newVersion,
      dependsOnId:       milestone.dependsOnId ?? null,
      offsetDays:        milestone.offsetDays ?? null,
    },
  });

  return NextResponse.json({
    ok:           true,
    milestoneId,
    newStartDate,
    newDueDate,
    version:      newVersion,
    previousVersion: expectedVersion,
  });
}
