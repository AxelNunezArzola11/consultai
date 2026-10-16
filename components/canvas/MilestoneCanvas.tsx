"use client";

/**
 * MilestoneCanvas — the live-building plan on the right side of the split screen.
 *
 * Features:
 *   - Drag to reorder milestones (@hello-pangea/dnd)
 *   - Inline budget edit with instant total recalculation
 *   - Fee line with processing-fee estimate (FEE_DISPLAY_POLICY from Phase 1)
 *   - Debounced agent comment on budget edits ("this budget looks low for the scope")
 *   - Loading skeletons while plan is building
 *   - Light/dark, responsive
 *   - "Fund milestone" button that calls onFundMilestone
 *
 * The Gantt view (GanttView) is rendered separately below the canvas.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";
import type { BriefPlan, BriefMilestone } from "@/lib/brief/schema";
import { BRIEF_LIMITS } from "@/lib/brief/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Fee policy (from env via server component → passed as props)
// ---------------------------------------------------------------------------

export interface FeePolicy {
  /** Observed: 0.13 = 13% approximation. UNVERIFIED for large amounts. */
  captureFeeFraction: number;
  /** Observed: $0.25 flat on $1. UNVERIFIED for large amounts. */
  payoutFeeUsd: number;
  /** GROSS_ONLY | SHOW_FEE | COMPANY_ABSORBS */
  displayPolicy: "GROSS_ONLY" | "SHOW_FEE" | "COMPANY_ABSORBS";
}

export const DEFAULT_FEE_POLICY: FeePolicy = {
  captureFeeFraction: 0.132, // 13.2% observed on $5.00 (Spike 1b)
  payoutFeeUsd: 0.25,        // $0.25 observed on $1.00 (Spike 1)
  displayPolicy: "SHOW_FEE",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MilestoneCanvasProps {
  plan: BriefPlan | null;
  isStreaming: boolean;
  feePolicy?: FeePolicy;
  onPlanChange: (plan: BriefPlan) => void;
  onFundMilestone: (milestoneId: string) => void;
  /** projectId — needed to route to existing milestones page */
  projectId: string;
}

interface MilestoneRow extends BriefMilestone {
  /** Local edits not yet saved */
  localBudget?: number;
  /** Agent comment on this row */
  comment?: string;
}

// ---------------------------------------------------------------------------
// Fee calculator
// ---------------------------------------------------------------------------

function calcFeeBreakdown(
  budgetUsd: number,
  policy: FeePolicy
): { gross: number; captureFee: number; netToConsultant: number; payoutFee: number } {
  const captureFee = budgetUsd * policy.captureFeeFraction;
  const payoutFee = policy.payoutFeeUsd;
  const netToConsultant = budgetUsd - captureFee - payoutFee;
  return { gross: budgetUsd, captureFee, netToConsultant, payoutFee };
}

// ---------------------------------------------------------------------------
// Debounced agent comment
// ---------------------------------------------------------------------------

const BUDGET_COMMENT_DEBOUNCE_MS = 1500;

function useDebouncedComment(
  budget: number,
  scope: string
): string | null {
  const [comment, setComment] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (budget < 200 && scope.length > 20) {
        setComment(
          `💡 This budget ($${budget}) looks low for the described scope. Consider increasing it.`
        );
      } else if (budget > 20_000) {
        setComment(
          `💡 This is a large milestone ($${budget.toLocaleString()}). Consider breaking it into smaller steps.`
        );
      } else {
        setComment(null);
      }
    }, BUDGET_COMMENT_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [budget, scope]);

  return comment;
}

// ---------------------------------------------------------------------------
// MilestoneRow component
// ---------------------------------------------------------------------------

function MilestoneRowCard({
  milestone,
  index,
  feePolicy,
  onBudgetChange,
  onFund,
  isDragging,
}: {
  milestone: MilestoneRow;
  index: number;
  feePolicy: FeePolicy;
  onBudgetChange: (id: string, val: number) => void;
  onFund: (id: string) => void;
  isDragging: boolean;
}) {
  const [editBudget, setEditBudget] = useState(
    String(milestone.localBudget ?? milestone.budgetUsd)
  );
  const [focused, setFocused] = useState(false);

  const effectiveBudget = parseFloat(editBudget) || milestone.budgetUsd;
  const feeBreakdown = calcFeeBreakdown(effectiveBudget, feePolicy);
  const comment = useDebouncedComment(effectiveBudget, milestone.description);

  const objectiveCriteria = milestone.acceptanceCriteria.filter(
    (c) => c.kind !== "SUBJECTIVE"
  );
  const subjectiveCriteria = milestone.acceptanceCriteria.filter(
    (c) => c.kind === "SUBJECTIVE"
  );

  function handleBudgetBlur() {
    setFocused(false);
    const parsed = parseFloat(editBudget);
    if (!isNaN(parsed) && parsed >= BRIEF_LIMITS.MIN_MILESTONE_BUDGET_USD) {
      onBudgetChange(milestone.id, parsed);
    } else {
      // Reset to current value on invalid input
      setEditBudget(String(milestone.localBudget ?? milestone.budgetUsd));
    }
  }

  return (
    <Card
      className={`transition-shadow ${isDragging ? "shadow-lg ring-2 ring-primary/40" : ""}`}
    >
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start gap-2">
          {/* Drag handle */}
          <div className="mt-1 text-muted-foreground cursor-grab active:cursor-grabbing select-none text-sm px-1">
            ⠿
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground">
                M{index + 1}
              </span>
              <h3 className="font-semibold text-sm leading-snug">{milestone.title}</h3>
              <span className="text-xs text-muted-foreground">
                +{milestone.dueDaysOffset}d
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
              {milestone.description}
            </p>
          </div>

          {/* Budget input */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className="text-xs text-muted-foreground">$</span>
            <input
              type="number"
              value={editBudget}
              onChange={(e) => setEditBudget(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={handleBudgetBlur}
              min={BRIEF_LIMITS.MIN_MILESTONE_BUDGET_USD}
              max={BRIEF_LIMITS.MAX_MILESTONE_BUDGET_USD}
              step={50}
              className="w-24 text-right text-sm font-semibold border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring bg-background"
              aria-label={`Budget for ${milestone.title}`}
            />
          </div>
        </div>

        {/* Fee breakdown (SHOW_FEE policy) */}
        {feePolicy.displayPolicy === "SHOW_FEE" && (
          <div className="text-xs text-muted-foreground space-y-0.5 border-t pt-2">
            <div className="flex justify-between">
              <span>You pay</span>
              <span className="font-medium text-foreground">
                ${feeBreakdown.gross.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Processing fee (est.)</span>
              <span>−${feeBreakdown.captureFee.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span>Payout fee (est.)</span>
              <span>−${feeBreakdown.payoutFee.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-semibold text-foreground border-t mt-1 pt-1">
              <span>Consultant receives</span>
              <span>${Math.max(0, feeBreakdown.netToConsultant).toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* Criteria */}
        <div className="space-y-1">
          {objectiveCriteria.map((c) => (
            <div key={c.id} className="flex items-center gap-1.5 text-xs">
              <span className="text-emerald-600 dark:text-emerald-400">✓</span>
              <span className="text-muted-foreground line-clamp-1">{c.description}</span>
              <Badge variant="outline" className="text-[10px] px-1 py-0 ml-auto">
                {c.kind}
              </Badge>
            </div>
          ))}
          {subjectiveCriteria.map((c) => (
            <div key={c.id} className="flex items-center gap-1.5 text-xs">
              <span className="text-amber-500">⚠</span>
              <span className="text-muted-foreground line-clamp-1">{c.description}</span>
              <Badge variant="outline" className="text-[10px] px-1 py-0 ml-auto text-amber-600 border-amber-300">
                human review
              </Badge>
            </div>
          ))}
        </div>

        {/* Debounced agent comment */}
        {comment && (
          <div className="text-xs text-muted-foreground bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded px-2 py-1.5 animate-in fade-in">
            {comment}
          </div>
        )}

        {/* Fund button */}
        <div className="flex justify-end pt-1">
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-7"
            onClick={() => onFund(milestone.id)}
          >
            💳 Fund milestone
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MilestoneCanvas
// ---------------------------------------------------------------------------

export function MilestoneCanvas({
  plan,
  isStreaming,
  feePolicy = DEFAULT_FEE_POLICY,
  onPlanChange,
  onFundMilestone,
  projectId,
}: MilestoneCanvasProps) {
  const [rows, setRows] = useState<MilestoneRow[]>([]);

  // Sync from parent plan (agent output), preserving local budget edits
  useEffect(() => {
    if (!plan) return;
    setRows((prev) => {
      const prevById = new Map(prev.map((r) => [r.id, r]));
      return plan.milestones.map((m) => ({
        ...m,
        localBudget: prevById.get(m.id)?.localBudget,
      }));
    });
  }, [plan]);

  // Drag reorder
  const handleDragEnd = useCallback(
    (result: DropResult) => {
      if (!result.destination || !plan) return;
      const newRows = [...rows];
      const [moved] = newRows.splice(result.source.index, 1);
      newRows.splice(result.destination.index, 0, moved);
      setRows(newRows);
      // Propagate reordered plan to parent
      onPlanChange({
        ...plan,
        milestones: newRows.map(({ localBudget: _lb, comment: _c, ...m }) => ({
          ...m,
          budgetUsd: _lb ?? m.budgetUsd,
        })),
      });
    },
    [rows, plan, onPlanChange]
  );

  // Budget inline edit
  const handleBudgetChange = useCallback(
    (id: string, newBudget: number) => {
      if (!plan) return;
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, localBudget: newBudget } : r))
      );
      // Recalculate total and propagate
      const updated = rows.map((r) => ({
        ...r,
        budgetUsd: r.id === id ? newBudget : (r.localBudget ?? r.budgetUsd),
      }));
      const newTotal = updated.reduce((s, r) => s + r.budgetUsd, 0);
      onPlanChange({
        ...plan,
        milestones: updated.map(({ localBudget: _lb, comment: _c, ...m }) => m),
        totalBudgetUsd: newTotal,
      });
    },
    [rows, plan, onPlanChange]
  );

  const effectiveTotal = rows.reduce(
    (s, r) => s + (r.localBudget ?? r.budgetUsd),
    0
  );

  // Skeleton rows while streaming and no plan yet
  if (isStreaming && rows.length === 0) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="border rounded-lg p-4 space-y-2">
            <Skeleton className="h-4 w-1/2" style={{ animationDelay: `${i * 100}ms` }} />
            <Skeleton className="h-3 w-3/4" style={{ animationDelay: `${i * 100 + 50}ms` }} />
            <Skeleton className="h-3 w-1/3" style={{ animationDelay: `${i * 100 + 100}ms` }} />
          </div>
        ))}
      </div>
    );
  }

  if (!plan || rows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <div className="space-y-2 max-w-xs">
          <div className="text-3xl">📋</div>
          <p className="text-muted-foreground text-sm font-medium">Plan builds here</p>
          <p className="text-xs text-muted-foreground">
            As you describe your project in the chat, your milestone plan will appear here automatically.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Plan header */}
      <div className="px-4 py-3 border-b bg-background flex-shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm truncate">{plan.projectTitle}</h2>
            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
              {plan.projectSummary}
            </p>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-bold">
              ${effectiveTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
            <div className="text-xs text-muted-foreground">{rows.length} milestones</div>
          </div>
        </div>

        {/* Total mismatch warning */}
        {Math.abs(effectiveTotal - plan.totalBudgetUsd) > 0.01 && (
          <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            ⚠ Total changed to ${effectiveTotal.toFixed(2)} (was ${plan.totalBudgetUsd.toFixed(2)})
          </div>
        )}
      </div>

      {/* Scrollable milestone list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="milestones">
            {(provided) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                className="space-y-2"
              >
                {rows.map((milestone, index) => (
                  <Draggable
                    key={milestone.id}
                    draggableId={milestone.id}
                    index={index}
                  >
                    {(provided2, snapshot2) => (
                      <div
                        ref={provided2.innerRef}
                        {...provided2.draggableProps}
                        {...provided2.dragHandleProps}
                      >
                        <MilestoneRowCard
                          milestone={milestone}
                          index={index}
                          feePolicy={feePolicy}
                          onBudgetChange={handleBudgetChange}
                          onFund={onFundMilestone}
                          isDragging={snapshot2.isDragging}
                        />
                      </div>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      </div>

      {/* Streaming indicator */}
      {isStreaming && (
        <div className="px-4 py-2 border-t bg-muted/30 flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
          <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
          AI is building your plan…
        </div>
      )}
    </div>
  );
}
