"use client";

/**
 * VettingAIHarness — In-Product AI Chat Assistant for Vetting & Gantt.
 *
 * Architecture (PayPal AG Grid boilerplate pattern):
 *   Chat UI → Harness (Conversation Manager) → Agents → Tools
 *     · filter_candidates      — mutates filter state via onFilterCandidates callback
 *     · assign_candidate       — notifies parent via onAssignCandidate callback
 *     · reschedule_milestone   — notifies parent via onRescheduleMilestone callback
 *     · query_vetting_summary  — returns textual summary inline
 *     · smart_reschedule_gantt — full-timeline re-levelling via onSmartReschedule callback
 *
 * Usage: drop into the vetting page or milestones page as a floating chat panel.
 * The panel is collapsible so it doesn't obstruct the main grid/Gantt views.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FilterCriteria {
  minTrustScore?: number;
  skill?: string;
  onlyShortlisted?: boolean;
}

interface AssignEvent {
  candidateName: string;
  milestoneName: string;
}

interface RescheduleEvent {
  milestoneName: string;
  newStartDate: string;
}

export interface GanttMilestoneUpdate {
  id: string;
  title: string;
  startDate: string | null;
  dueDate: string | null;
}

export interface SmartRescheduleResult {
  intent: string;
  updates: GanttMilestoneUpdate[];
  message: string;
}

export interface VettingAIHarnessProps {
  projectId: string;
  /** Current milestones — passed to smart_reschedule_gantt tool */
  milestones?: GanttMilestoneUpdate[];
  /** Called when AI tool filter_candidates fires — mutate your AG Grid filter */
  onFilterCandidates?: (criteria: FilterCriteria) => void;
  /** Called when AI tool assign_candidate fires */
  onAssignCandidate?: (event: AssignEvent) => void;
  /** Called when AI tool reschedule_milestone fires */
  onRescheduleMilestone?: (event: RescheduleEvent) => void;
  /** Called when smart_reschedule_gantt fires with a full updated milestone list */
  onSmartReschedule?: (result: SmartRescheduleResult) => void;
}

// ── Tool result renderer ──────────────────────────────────────────────────────

interface ToolResult {
  action: string;
  message: string;
  criteria?: FilterCriteria;
  candidateName?: string;
  milestoneName?: string;
  newStartDate?: string;
  focus?: string;
  intent?: string;
  updates?: GanttMilestoneUpdate[];
}

function ToolResultBadge({ result, onApplyReschedule }: { result: ToolResult; onApplyReschedule?: (r: SmartRescheduleResult) => void }) {
  const icons: Record<string, string> = {
    filter_candidates:     "⊞",
    assign_candidate:      "→",
    reschedule_milestone:  "◷",
    query_vetting_summary: "◎",
    smart_reschedule_gantt: "⟳",
  };

  const isSmartReschedule = result.action === "smart_reschedule_gantt" && Array.isArray(result.updates);

  return (
    <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/8 p-2.5 text-xs mt-1">
      <span className="text-primary shrink-0 mt-0.5">{icons[result.action] ?? "◈"}</span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-primary text-[11px] uppercase tracking-wide mb-0.5">
          {result.action.replace(/_/g, " ")}
        </p>
        <p className="text-foreground/80">{result.message}</p>
        {isSmartReschedule && result.updates && result.intent && (
          <div className="mt-2 space-y-1">
            <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
              {result.updates.length} milestone(s) recalculated:
            </p>
            <div className="space-y-0.5 max-h-28 overflow-y-auto">
              {result.updates.slice(0, 6).map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-2 bg-muted/30 rounded px-2 py-1">
                  <span className="text-foreground/80 truncate text-[10px]">{u.title}</span>
                  <span className="text-muted-foreground text-[10px] tabular-nums shrink-0">
                    {u.dueDate ?? "—"}
                  </span>
                </div>
              ))}
              {result.updates.length > 6 && (
                <p className="text-[10px] text-muted-foreground text-center">…and {result.updates.length - 6} more</p>
              )}
            </div>
            {onApplyReschedule && (
              <button
                type="button"
                onClick={() => onApplyReschedule({ intent: result.intent!, updates: result.updates!, message: result.message })}
                className="mt-1.5 w-full text-[11px] font-semibold text-primary bg-primary/10 hover:bg-primary/20 border border-primary/20 rounded px-3 py-1.5 transition-colors"
              >
                ⟳ Apply to Timeline
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function VettingAIHarness({
  projectId,
  milestones = [],
  onFilterCandidates,
  onAssignCandidate,
  onRescheduleMilestone,
  onSmartReschedule,
}: VettingAIHarnessProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  // Keep a stable ref to the latest milestones so the transport body stays current
  const milestonesRef = useRef(milestones);
  useEffect(() => { milestonesRef.current = milestones; }, [milestones]);
  // Stable transport reference — instantiated once (same pattern as ChatPanel.tsx)
  // eslint-disable-next-line react-hooks/refs
  const transport = useRef(new DefaultChatTransport({ api: "/api/agent/harness", body: { projectId } })).current;

  const { messages, sendMessage, status } = useChat({
    transport,
  });

  // Tool call side-effects are handled by parsing tool-result parts from messages
  // (onToolCall type signature varies by SDK version — we use message parts instead)

  const isLoading = status === "streaming" || status === "submitted";

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    sendMessage({ text });
  }, [input, isLoading, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Fire side-effect callbacks for tool calls contained in messages
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    const parts = Array.isArray(lastMsg.parts)
      ? (lastMsg.parts as Array<{ type?: string; toolName?: string; result?: unknown }>)
      : [];
    for (const part of parts) {
      if (part.type !== "tool-result") continue;
      const r = part.result as ToolResult | null;
      if (!r) continue;
      if (r.action === "filter_candidates" && r.criteria) onFilterCandidates?.(r.criteria);
      if (r.action === "assign_candidate" && r.candidateName && r.milestoneName) {
        onAssignCandidate?.({ candidateName: r.candidateName, milestoneName: r.milestoneName });
      }
      if (r.action === "reschedule_milestone" && r.milestoneName && r.newStartDate) {
        onRescheduleMilestone?.({ milestoneName: r.milestoneName, newStartDate: r.newStartDate });
      }
    }
  // Only run when messages change (not on every render)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Suggestions for the empty state
  const suggestions = [
    "Show candidates with trust score > 70",
    "Filter by React skill",
    "Re-level timeline for a 20 hr/week candidate",
    "Shift all delivery phases by 2 weeks",
  ];

  return (
    <div
      className={[
        "fixed bottom-6 right-6 z-50 flex flex-col transition-all duration-300 ease-in-out",
        isOpen ? "w-80 sm:w-96" : "w-auto",
      ].join(" ")}
      style={{ maxHeight: isOpen ? "min(520px, calc(100vh - 80px))" : "auto" }}
    >
      {/* Chat panel */}
      {isOpen && (
        <div className="flex flex-col rounded-2xl border border-border bg-card shadow-2xl shadow-black/30 overflow-hidden mb-2" style={{ height: "460px" }}>
          {/* Header */}
          <div className="px-4 py-3 border-b border-border bg-card/80 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex w-6 h-6 rounded-md bg-primary/15 text-primary items-center justify-center text-xs font-bold">
                AI
              </span>
              <div>
                <p className="text-xs font-semibold text-foreground">Vetting Assistant</p>
                <p className="text-[10px] text-muted-foreground">AG Grid · Bryntum Gantt</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-muted-foreground hover:text-foreground transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
            {messages.length === 0 && !isLoading && (
              <div className="space-y-3">
                <div className="text-center py-4">
                  <div className="text-3xl mb-2 opacity-30">◎</div>
                  <p className="text-xs text-muted-foreground font-medium">Ask me about candidates, milestones, or vetting scores</p>
                </div>
                <div className="space-y-1.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => { setInput(s); }}
                      className="w-full text-left text-[11px] text-muted-foreground hover:text-foreground bg-muted/30 hover:bg-muted/60 border border-border/50 px-3 py-2 rounded-lg transition-all"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => {
              const parts = Array.isArray(msg.parts) ? msg.parts as Array<{ type?: string; text?: string; toolName?: string; result?: unknown }> : [];
              const textContent = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
              const toolResults = parts
                .filter((p) => p.type === "tool-result")
                .map((p) => p.result as ToolResult)
                .filter(Boolean);

              const isUser = msg.role === "user";

              return (
                <div key={msg.id} className={`flex gap-2 items-start ${isUser ? "flex-row-reverse" : ""}`}>
                  <div className={`w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-semibold ${
                    isUser ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground"
                  }`}>
                    {isUser ? "U" : "AI"}
                  </div>
                  <div className={`max-w-[85%] space-y-1 ${isUser ? "items-end" : "items-start"}`}>
                    {textContent && (
                      <div className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${
                        isUser
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/50 text-foreground"
                      }`}>
                        {textContent}
                      </div>
                    )}
                    {toolResults.map((tr, i) => (
                      <ToolResultBadge
                        key={i}
                        result={tr}
                        onApplyReschedule={tr.action === "smart_reschedule_gantt" ? onSmartReschedule : undefined}
                      />
                    ))}
                  </div>
                </div>
              );
            })}

            {isLoading && (
              <div className="flex gap-2 items-center text-muted-foreground">
                <div className="w-5 h-5 rounded-full bg-muted/60 flex-shrink-0 flex items-center justify-center text-[10px]">AI</div>
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce"
                      style={{ animationDelay: `${i * 120}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-border p-3 bg-card/80 shrink-0">
            <div className="flex gap-2 items-end">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about candidates or milestones…"
                rows={2}
                disabled={isLoading}
                className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 transition-opacity"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="self-end rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm shadow-primary/20"
              >
                {isLoading ? (
                  <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : "↑"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating trigger button */}
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className={[
          "self-end flex items-center gap-2 rounded-2xl px-4 py-3 text-xs font-semibold shadow-lg transition-all duration-200 active:scale-[0.97]",
          isOpen
            ? "bg-muted/80 border border-border text-foreground hover:bg-muted"
            : "bg-primary text-primary-foreground hover:bg-primary/90 shadow-primary/25",
        ].join(" ")}
        title="AI Vetting &amp; Gantt Assistant"
      >
        <span className="text-base">◎</span>
        <span className="hidden sm:inline">{isOpen ? "Close AI" : "AI Assistant"}</span>
      </button>
    </div>
  );
}
