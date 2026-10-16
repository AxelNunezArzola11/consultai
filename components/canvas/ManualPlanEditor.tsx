"use client";

/**
 * ManualPlanEditor — Fallback plan editor shown when the LLM fails or hits a rate limit.
 *
 * Features:
 *   - Pre-filled from a cached example plan (labelled "demo only") or from draft
 *   - "Use example brief" button loads the cached plan instantly
 *   - Edit all fields inline: title, summary, budgets, due offsets, criteria
 *   - Add / remove milestones up to MAX_MILESTONES
 *   - Real-time validation (budget limits, totals, future dates)
 *   - "Save plan" calls onSave with a validated BriefPlan
 */

import React, { useState, useCallback } from "react";
import type { BriefPlan, BriefMilestone, AcceptanceCriterion } from "@/lib/brief/schema";
import { BRIEF_LIMITS, normalizeBriefPlan, SUPPORTED_OBJECTIVE_KINDS } from "@/lib/brief/schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Demo example plan (cached, labelled demo-only)
// ---------------------------------------------------------------------------

export const EXAMPLE_BRIEF_PLAN: BriefPlan = {
  projectTitle: "AI Analytics Dashboard [Demo]",
  projectSummary:
    "Rebuild the internal analytics dashboard with real-time data streaming, natural language queries, and PayPal transaction integration.",
  totalBudgetUsd: 3500,
  milestones: [
    {
      id: "demo-m1",
      title: "Design & UX specification",
      description:
        "Figma designs for all dashboard views, mobile breakpoints, and component library",
      budgetUsd: 800,
      dueDaysOffset: 7,
      acceptanceCriteria: [
        {
          id: "demo-ac1",
          description: "Figma file delivered with all views and responsive breakpoints",
          kind: "files_present",
          requiredFiles: ["design/dashboard.fig"],
        },
        {
          id: "demo-ac2",
          description: "Design approved by stakeholder in PR review",
          kind: "required_review_approved",
        },
      ],
    },
    {
      id: "demo-m2",
      title: "Backend API & data pipeline",
      description:
        "REST API endpoints, real-time streaming, PayPal webhook integration",
      budgetUsd: 1500,
      dueDaysOffset: 21,
      acceptanceCriteria: [
        {
          id: "demo-ac3",
          description: "All CI checks pass on the PR",
          kind: "ci_passes",
        },
        {
          id: "demo-ac4",
          description: "PR merged to main branch",
          kind: "pr_merged",
        },
      ],
    },
    {
      id: "demo-m3",
      title: "Frontend integration & testing",
      description: "Next.js frontend, E2E tests with Playwright, performance audit",
      budgetUsd: 1200,
      dueDaysOffset: 35,
      acceptanceCriteria: [
        {
          id: "demo-ac5",
          description: "CI passes and no workflow files modified",
          kind: "no_workflow_or_test_tampering",
        },
        {
          id: "demo-ac6",
          description: "PR merged to main",
          kind: "pr_merged",
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// ManualPlanEditor
// ---------------------------------------------------------------------------

interface ManualPlanEditorProps {
  /** Pre-filled draft (from LLM or draft DB row) — if null, start from example */
  initialPlan?: BriefPlan | null;
  /** LLM error message that triggered the fallback */
  llmError?: string;
  onSave: (plan: BriefPlan) => void;
  onRetryLLM?: () => void;
}

export function ManualPlanEditor({
  initialPlan,
  llmError,
  onSave,
  onRetryLLM,
}: ManualPlanEditorProps) {
  const [plan, setPlan] = useState<BriefPlan>(initialPlan ?? EXAMPLE_BRIEF_PLAN);
  const [isDemoExample, setIsDemoExample] = useState(!initialPlan);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Recompute total from milestones
  function syncTotal(milestones: BriefMilestone[]): BriefPlan {
    const total = milestones.reduce((s, m) => s + m.budgetUsd, 0);
    return { ...plan, milestones, totalBudgetUsd: total };
  }

  // Top-level field changes
  function updateField<K extends keyof BriefPlan>(key: K, value: BriefPlan[K]) {
    setPlan((prev) => ({ ...prev, [key]: value }));
    setIsDemoExample(false);
  }

  // Milestone field changes
  function updateMilestone(
    milestoneId: string,
    updates: Partial<BriefMilestone>
  ) {
    setPlan((prev) => {
      const newMilestones = prev.milestones.map((m) =>
        m.id === milestoneId ? { ...m, ...updates } : m
      );
      return syncTotal(newMilestones);
    });
    setIsDemoExample(false);
  }

  // Add milestone
  function addMilestone() {
    if (plan.milestones.length >= BRIEF_LIMITS.MAX_MILESTONES) return;
    const lastOffset =
      plan.milestones.length > 0
        ? plan.milestones[plan.milestones.length - 1].dueDaysOffset + 14
        : 14;
    const newM: BriefMilestone = {
      id: nanoid(),
      title: "New milestone",
      description: "Describe this milestone",
      budgetUsd: BRIEF_LIMITS.MIN_MILESTONE_BUDGET_USD,
      dueDaysOffset: lastOffset,
      acceptanceCriteria: [
        {
          id: nanoid(),
          description: "Milestone criterion",
          kind: "pr_merged",
        },
      ],
    };
    setPlan((prev) => {
      const newMilestones = [...prev.milestones, newM];
      return syncTotal(newMilestones);
    });
    setIsDemoExample(false);
  }

  // Remove milestone
  function removeMilestone(id: string) {
    setPlan((prev) => {
      const newMilestones = prev.milestones.filter((m) => m.id !== id);
      return syncTotal(newMilestones);
    });
  }

  // Save with validation
  function handleSave() {
    const { errors, plan: normalized } = normalizeBriefPlan(plan);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    setValidationErrors([]);
    onSave(normalized);
  }

  // Load example
  function loadExample() {
    setPlan(EXAMPLE_BRIEF_PLAN);
    setIsDemoExample(true);
    setValidationErrors([]);
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      {/* Error banner */}
      {llmError && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 text-sm text-destructive flex items-start gap-2">
          <span>⚠</span>
          <div className="flex-1">
            <p className="font-medium">AI unavailable — manual editor</p>
            <p className="text-xs mt-0.5 opacity-80">{llmError}</p>
          </div>
          {onRetryLLM && (
            <button
              onClick={onRetryLLM}
              className="text-xs underline hover:no-underline flex-shrink-0"
            >
              Retry AI
            </button>
          )}
        </div>
      )}

      {/* Demo badge + example button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-sm">Manual Plan Editor</h2>
          {isDemoExample && (
            <Badge variant="secondary" className="text-xs">
              Demo only
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={loadExample} className="text-xs">
          Use example brief
        </Button>
      </div>

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 space-y-1">
          {validationErrors.map((e, i) => (
            <p key={i} className="text-xs text-destructive">
              • {e}
            </p>
          ))}
        </div>
      )}

      {/* Project title & summary */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground block">
          Project title
        </label>
        <input
          value={plan.projectTitle}
          onChange={(e) => updateField("projectTitle", e.target.value)}
          className="w-full border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          maxLength={200}
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground block">
          Project summary
        </label>
        <textarea
          value={plan.projectSummary}
          onChange={(e) => updateField("projectSummary", e.target.value)}
          rows={2}
          className="w-full border rounded px-3 py-1.5 text-sm bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          maxLength={1000}
        />
      </div>

      {/* Milestones */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-muted-foreground">
            Milestones ({plan.milestones.length}/{BRIEF_LIMITS.MAX_MILESTONES})
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={addMilestone}
            disabled={plan.milestones.length >= BRIEF_LIMITS.MAX_MILESTONES}
            className="text-xs h-7"
          >
            + Add
          </Button>
        </div>

        {plan.milestones.map((m, i) => (
          <MilestoneEditor
            key={m.id}
            milestone={m}
            index={i}
            onChange={(updates) => updateMilestone(m.id, updates)}
            onRemove={() => removeMilestone(m.id)}
            canRemove={plan.milestones.length > 1}
          />
        ))}
      </div>

      {/* Totals */}
      <div className="border rounded-lg p-3 text-sm bg-muted/20 space-y-1">
        <div className="flex justify-between font-semibold">
          <span>Total budget</span>
          <span>${plan.totalBudgetUsd.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Sum of milestones</span>
          <span>
            ${plan.milestones.reduce((s, m) => s + m.budgetUsd, 0).toFixed(2)}
          </span>
        </div>
      </div>

      {/* Save */}
      <Button onClick={handleSave} className="w-full">
        Save plan
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MilestoneEditor — inline form for a single milestone
// ---------------------------------------------------------------------------

function MilestoneEditor({
  milestone,
  index,
  onChange,
  onRemove,
  canRemove,
}: {
  milestone: BriefMilestone;
  index: number;
  onChange: (updates: Partial<BriefMilestone>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">M{index + 1}</span>
          <input
            value={milestone.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Milestone title"
            className="flex-1 border rounded px-2 py-1 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            maxLength={120}
          />
          {canRemove && (
            <button
              onClick={onRemove}
              className="text-xs text-muted-foreground hover:text-destructive ml-1"
              title="Remove milestone"
            >
              ×
            </button>
          )}
        </div>

        <textarea
          value={milestone.description}
          onChange={(e) => onChange({ description: e.target.value })}
          rows={2}
          placeholder="Milestone description"
          className="w-full border rounded px-2 py-1 text-xs bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          maxLength={800}
        />

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">Budget (USD)</label>
            <input
              type="number"
              value={milestone.budgetUsd}
              onChange={(e) =>
                onChange({ budgetUsd: parseFloat(e.target.value) || BRIEF_LIMITS.MIN_MILESTONE_BUDGET_USD })
              }
              min={BRIEF_LIMITS.MIN_MILESTONE_BUDGET_USD}
              max={BRIEF_LIMITS.MAX_MILESTONE_BUDGET_USD}
              step={50}
              className="w-full border rounded px-2 py-1 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="w-24">
            <label className="text-xs text-muted-foreground">Due (days)</label>
            <input
              type="number"
              value={milestone.dueDaysOffset}
              onChange={(e) =>
                onChange({ dueDaysOffset: parseInt(e.target.value, 10) || 1 })
              }
              min={1}
              step={1}
              className="w-full border rounded px-2 py-1 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* Criteria (simple list) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted-foreground">Acceptance criteria</label>
            <button
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                onChange({
                  acceptanceCriteria: [
                    ...milestone.acceptanceCriteria,
                    {
                      id: nanoid(),
                      description: "New criterion",
                      kind: "pr_merged",
                    } as AcceptanceCriterion,
                  ],
                })
              }
            >
              + add
            </button>
          </div>
          {milestone.acceptanceCriteria.map((c, ci) => (
            <div key={c.id} className="flex gap-1 items-center">
              <select
                value={c.kind}
                onChange={(e) => {
                  const updated = [...milestone.acceptanceCriteria];
                  updated[ci] = { ...c, kind: e.target.value };
                  onChange({ acceptanceCriteria: updated });
                }}
                className="text-xs border rounded px-1 py-0.5 bg-background focus:outline-none"
              >
                {SUPPORTED_OBJECTIVE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                <option value="SUBJECTIVE">SUBJECTIVE (human review)</option>
              </select>
              <input
                value={c.description}
                onChange={(e) => {
                  const updated = [...milestone.acceptanceCriteria];
                  updated[ci] = { ...c, description: e.target.value };
                  onChange({ acceptanceCriteria: updated });
                }}
                className="flex-1 text-xs border rounded px-1.5 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="Criterion description"
              />
              {milestone.acceptanceCriteria.length > 1 && (
                <button
                  className="text-xs text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    onChange({
                      acceptanceCriteria: milestone.acceptanceCriteria.filter(
                        (_, j) => j !== ci
                      ),
                    })
                  }
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
