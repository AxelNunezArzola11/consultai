"use client";

/**
 * NewProjectClient — client component for the new project page.
 *
 * Split screen:
 *   Left panel  — ChatPanel (BriefAgent chat)
 *   Right panel — MilestoneCanvas (live plan) + GanttView (timeline)
 *
 * Fallback:
 *   If the LLM errors or hits rate limit, the right panel switches to ManualPlanEditor.
 *
 * Persistence:
 *   Every plan update is saved to brief_drafts via /api/agent/brief-draft.
 *
 * Draft saving:
 *   Debounced 1s after each plan update.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import { nanoid } from "nanoid";
import type { BriefPlan } from "@/lib/brief/schema";
import type { FeePolicy } from "@/components/canvas/MilestoneCanvas";
import { ChatPanel } from "@/components/agent/ChatPanel";
import { MilestoneCanvas } from "@/components/canvas/MilestoneCanvas";
import { ManualPlanEditor } from "@/components/canvas/ManualPlanEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";

// Gantt loaded client-side only (DnD requires browser)
const GanttView = dynamic(
  () => import("@/components/canvas/GanttView"),
  { ssr: false }
);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NewProjectClientProps {
  projectId: string;
  initialBrief?: string;
  feePolicy: FeePolicy;
}

// ---------------------------------------------------------------------------
// Draft save (debounced)
// ---------------------------------------------------------------------------

function useDraftSave(projectId: string, agentSessionId: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (plan: BriefPlan) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        try {
          await fetch("/api/agent/brief-draft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId, agentSessionId, plan }),
          });
        } catch {
          // Non-fatal: draft save failure doesn't block the user
          console.warn("[NewProjectClient] Draft save failed");
        }
      }, 1000);
    },
    [projectId, agentSessionId]
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GitHub repo URL input (persisted to DB on blur)
// ---------------------------------------------------------------------------

function useGithubRepoSave(projectId: string) {
  return useCallback(
    async (url: string) => {
      if (!url) return;
      try {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ githubRepoUrl: url || null }),
        });
      } catch {
        console.warn("[NewProjectClient] GitHub repo URL save failed");
      }
    },
    [projectId]
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewProjectClient({
  projectId,
  initialBrief,
  feePolicy,
}: NewProjectClientProps) {
  // Stable agent session ID for this browser session
  const [agentSessionId] = useState(() => nanoid());

  // Plan state
  const [plan, setPlan] = useState<BriefPlan | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  // Fallback state
  const [llmError, setLlmError] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);

  // Show Gantt after plan is complete
  const [showGantt, setShowGantt] = useState(false);

  // GitHub repo URL (linked repository for milestone auto-evaluation)
  const [githubRepoUrl, setGithubRepoUrl] = useState("");
  const saveGithubRepo = useGithubRepoSave(projectId);

  // Draft save
  const saveDraft = useDraftSave(projectId, agentSessionId);

  // When plan updates, save draft + show Gantt
  const handlePlanUpdate = useCallback(
    (newPlan: BriefPlan) => {
      setPlan(newPlan);
      saveDraft(newPlan);
      setShowGantt(true);
    },
    [saveDraft]
  );

  // LLM error → show fallback
  const handleLLMError = useCallback((err: string) => {
    setLlmError(err);
    setShowFallback(true);
  }, []);

  // Retry LLM
  const handleRetryLLM = useCallback(() => {
    setLlmError(null);
    setShowFallback(false);
  }, []);

  // Fund milestone → navigate to milestones page
  const handleFundMilestone = useCallback(
    (_milestoneId: string) => {
      // Phase 1 checkout lives on the milestones page
      window.location.href = `/project/${projectId}/milestones`;
    },
    [projectId]
  );

  // Manual plan save (from fallback editor)
  const handleManualSave = useCallback(
    (savedPlan: BriefPlan) => {
      setPlan(savedPlan);
      saveDraft(savedPlan);
      setShowGantt(true);
      setShowFallback(false);
    },
    [saveDraft]
  );

  // Gantt reorder
  const handleGanttReorder = useCallback(
    (newMilestones: BriefPlan["milestones"]) => {
      if (!plan) return;
      const updated = { ...plan, milestones: newMilestones };
      setPlan(updated);
      saveDraft(updated);
    },
    [plan, saveDraft]
  );

  // Gantt budget change
  const handleGanttBudgetChange = useCallback(
    (milestoneId: string, newBudget: number) => {
      if (!plan) return;
      const updatedMilestones = plan.milestones.map((m) =>
        m.id === milestoneId ? { ...m, budgetUsd: newBudget } : m
      );
      const total = updatedMilestones.reduce((s, m) => s + m.budgetUsd, 0);
      const updated = { ...plan, milestones: updatedMilestones, totalBudgetUsd: total };
      setPlan(updated);
      saveDraft(updated);
    },
    [plan, saveDraft]
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* ─── Left: Chat ─────────────────────────────────────────────────── */}
      <div className="w-full md:w-[42%] flex-shrink-0 flex flex-col border-r bg-background overflow-hidden">
        {/* Chat panel header */}
        <div className="px-4 py-3 border-b flex flex-col gap-2 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-semibold text-sm">New Project</h1>
              <p className="text-xs text-muted-foreground">
                Describe your project — the AI will build the plan
              </p>
            </div>
            {plan && (
              <Link href={`/project/${projectId}/milestones`}>
                <Button size="sm" variant="outline" className="text-xs h-7">
                  View milestones →
                </Button>
              </Link>
            )}
          </div>

          {/* GitHub repo URL — links project to a repo for milestone auto-evaluation */}
          <div className="flex flex-col gap-1">
            <label htmlFor="github-repo-url" className="text-xs font-medium text-muted-foreground">
              GitHub Repository URL{" "}
              <span className="font-normal">(optional — enables PR milestone evaluation)</span>
            </label>
            <Input
              id="github-repo-url"
              placeholder="https://github.com/owner/repo"
              value={githubRepoUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGithubRepoUrl(e.target.value)}
              onBlur={() => saveGithubRepo(githubRepoUrl)}
              className="h-7 text-xs font-mono"
            />
          </div>
        </div>

        {/* Chat */}
        <div className="flex-1 overflow-hidden min-h-0">
          <ChatPanel
            projectId={projectId}
            agentSessionId={agentSessionId}
            onPlanUpdate={handlePlanUpdate}
            onLLMError={handleLLMError}
            initialBrief={initialBrief}
          />
        </div>
      </div>

      {/* ─── Right: Canvas or Fallback ──────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-muted/10">
        {showFallback ? (
          /* Fallback: manual editor */
          <div className="flex-1 overflow-hidden min-h-0">
            <ManualPlanEditor
              initialPlan={plan}
              llmError={llmError ?? undefined}
              onSave={handleManualSave}
              onRetryLLM={handleRetryLLM}
            />
          </div>
        ) : (
          /* Normal: canvas + optional Gantt */
          <div className="flex flex-col h-full overflow-hidden">
            {/* Canvas — live milestone cards */}
            <div
              className={`${showGantt ? "flex-none h-[55%]" : "flex-1"} overflow-hidden border-b`}
            >
              <MilestoneCanvas
                plan={plan}
                isStreaming={isStreaming}
                feePolicy={feePolicy}
                onPlanChange={handlePlanUpdate}
                onFundMilestone={handleFundMilestone}
                projectId={projectId}
              />
            </div>

            {/* Gantt view — appears after first plan */}
            {showGantt && plan && (
              <div className="flex-1 overflow-y-auto p-4 min-h-0">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold">Timeline</h3>
                  <span className="text-xs text-muted-foreground">
                    Drag to reorder
                  </span>
                </div>
                <GanttView
                  plan={plan}
                  onReorder={handleGanttReorder}
                  onBudgetChange={handleGanttBudgetChange}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
