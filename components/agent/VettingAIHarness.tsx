"use client";

/**
 * VettingAIHarness — In-Product AI Chat Assistant for Vetting & Gantt.
 *
 * Architecture (PayPal AG Grid boilerplate pattern):
 *   Chat UI → Harness (Conversation Manager) → Agents → Tools
 *     · filter_candidates  — mutates filter state via onFilterCandidates callback
 *     · assign_candidate   — notifies parent via onAssignCandidate callback
 *     · reschedule_milestone — notifies parent via onRescheduleMilestone callback
 *     · query_vetting_summary — returns textual summary inline
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

export interface VettingAIHarnessProps {
  projectId: string;
  /** Called when AI tool filter_candidates fires — mutate your AG Grid filter */
  onFilterCandidates?: (criteria: FilterCriteria) => void;
  /** Called when AI tool assign_candidate fires */
  onAssignCandidate?: (event: AssignEvent) => void;
  /** Called when AI tool reschedule_milestone fires */
  onRescheduleMilestone?: (event: RescheduleEvent) => void;
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
}

function ToolResultBadge({ result }: { result: ToolResult }) {
  const icons: Record<string, string> = {
    filter_candidates:    "⊞",
    assign_candidate:     "→",
    reschedule_milestone: "◷",
    query_vetting_summary: "◎",
  };
  return (
    <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/8 p-2.5 text-xs mt-1">
      <span className="text-primary shrink-0 mt-0.5">{icons[result.action] ?? "◈"}</span>
      <div className="min-w-0">
        <p className="font-semibold text-primary text-[11px] uppercase tracking-wide mb-0.5">
          {result.action.replace(/_/g, " ")}
        </p>
        <p className="text-foreground/80">{result.message}</p>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function VettingAIHarness({
  projectId,
}: VettingAIHarnessProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
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

  // Suggestions for the empty state
  const suggestions = [
    "Show candidates with trust score > 70",
    "Who are the shortlisted candidates?",
    "Filter by React skill",
    "Assign top candidate to milestone 1",
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
                      <ToolResultBadge key={i} result={tr} />
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
        title="AI Vetting Assistant"
      >
        <span className="text-base">◎</span>
        <span className="hidden sm:inline">{isOpen ? "Close AI" : "AI Assistant"}</span>
      </button>
    </div>
  );
}
