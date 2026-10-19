"use client";

/**
 * ChatPanel — BriefAgent chat UI.
 *
 * Architecture (Demo-Saver mode):
 *   - LLM streams Markdown text only — NO tool calls.
 *   - When the AI message contains a ```json fence matching BriefPlanSchema,
 *     an "Approve & Save Plan" button is rendered below that message.
 *   - Clicking it POSTs to /api/db/save-brief (fast DB-only route, ~200ms).
 *   - This completely separates LLM streaming from DB writes, eliminating
 *     the Vercel Hobby 10s timeout that hit when both happened in one request.
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { BRIEF_LIMITS } from "@/lib/brief/schema";
import type { BriefPlan } from "@/lib/brief/schema";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  projectId: string;
  agentSessionId: string;
  /** Called whenever the agent saves a new plan (partial or final) */
  onPlanUpdate: (plan: BriefPlan) => void;
  /** Called on any LLM / network error — parent shows fallback editor */
  onLLMError: (err: string) => void;
  initialBrief?: string;
}

// ---------------------------------------------------------------------------
// Network-error classifier
// ---------------------------------------------------------------------------

function classifyError(err: unknown): string {
  if (err instanceof Error) {
    const raw = err.message;
    let msg = raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.error === "string" && parsed.error) msg = parsed.error;
    } catch { /* not JSON */ }

    if (msg.includes("ERR_NETWORK_CHANGED") || msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("network")) {
      return "Network connection changed. Please check your connection and try again.";
    }
    if (msg.includes("rate limit") || msg.includes("429") || msg.includes("Rate limit")) {
      return "Rate limit reached. Please wait a moment before retrying.";
    }
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
      return "Request timed out. The AI service may be busy — please retry.";
    }
    if (msg.includes("GROQ_API_KEY") || msg.includes("not configured") || msg.includes("not set")) {
      return "The AI service is not configured on the server. Contact support.";
    }
    if (msg.includes("Forbidden") || msg.includes("403")) {
      return "Access denied — please reload and try again.";
    }
    return msg || "LLM request failed";
  }
  return "LLM request failed";
}

// ---------------------------------------------------------------------------
// Parse JSON plan from an AI message that contains a ```json fence.
// Handles two cases:
//   1. Complete fence: ```json { … } ```  — normal happy path
//   2. Truncated fence: ```json { … (no closing ```)  — model was cut off or
//      stream is still in progress; we attempt to parse anyway.
// Returns null if no valid BriefPlan-shaped JSON is found.
// ---------------------------------------------------------------------------

function extractPlanFromMessage(text: string): BriefPlan | null {
  // Try complete fence first (greedy from opening to closing ```)
  const completeMatch = text.match(/```json\s*([\s\S]*?)```/);
  // Fall back to everything after ```json if no closing fence
  const partialMatch = completeMatch ? null : text.match(/```json\s*([\s\S]+)$/);
  const raw = (completeMatch?.[1] ?? partialMatch?.[1] ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Minimal shape check — full validation happens server-side
    if (
      typeof parsed.projectTitle === "string" &&
      typeof parsed.totalBudgetUsd === "number" &&
      Array.isArray(parsed.milestones) &&
      parsed.milestones.length > 0
    ) {
      return parsed as unknown as BriefPlan;
    }
  } catch { /* malformed / incomplete JSON — not parseable yet */ }
  return null;
}

// Returns true if the message text contains an opening ```json fence,
// regardless of whether it is closed — used to suppress raw JSON display.
function messageHasJsonFence(text: string): boolean {
  return /```json/i.test(text);
}

// ---------------------------------------------------------------------------
// Approve & Save button — calls /api/db/save-brief directly
// ---------------------------------------------------------------------------

interface ApprovePlanButtonProps {
  plan: BriefPlan;
  projectId: string;
  agentSessionId: string;
  onSaved: (plan: BriefPlan, milestoneCount: number, downgradedCriteria: string[]) => void;
  onError: (msg: string) => void;
}

function ApprovePlanButton({ plan, projectId, agentSessionId, onSaved, onError }: ApprovePlanButtonProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleApprove = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/db/save-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, agentSessionId, plan }),
      });
      const data = await res.json() as {
        ok: boolean;
        milestoneCount?: number;
        downgradedCriteria?: string[];
        errors?: string[];
      };
      if (!res.ok || !data.ok) {
        onError(data.errors?.join(", ") ?? "Failed to save plan");
        return;
      }
      setSaved(true);
      onSaved(plan, data.milestoneCount ?? plan.milestones.length, data.downgradedCriteria ?? []);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Network error saving plan");
    } finally {
      setSaving(false);
    }
  }, [plan, projectId, agentSessionId, onSaved, onError]);

  if (saved) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <Badge className="text-xs bg-emerald-600 hover:bg-emerald-700">
          ✅ Plan saved — {plan.milestones.length} milestones
        </Badge>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <Button
        onClick={handleApprove}
        disabled={saving}
        size="sm"
        className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
      >
        {saving ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Saving…
          </span>
        ) : (
          "✅ Approve & Save Plan"
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatPanel({
  projectId,
  agentSessionId,
  onPlanUpdate,
  onLLMError,
  initialBrief,
}: ChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState(initialBrief ?? "");
  const [charCount, setCharCount] = useState((initialBrief ?? "").length);
  const hasAutoSent = useRef(false);

  // Inline error banner (non-fatal: user can dismiss and retry without switching to fallback)
  const [inlineError, setInlineError] = useState<string | null>(null);
  // Count consecutive errors — after 2, escalate to fallback
  const errorCountRef = useRef(0);

  // Track which message IDs have been saved (to show saved badge persistently)
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(new Set());

  // Build transport once (stable reference)
  const transport = useRef(
    new DefaultChatTransport({
      api: "/api/agent/brief",
      body: { projectId, agentSessionId },
    })
  ).current;

  const {
    messages,
    sendMessage,
    status,
  } = useChat({
    transport,
    onError: (err) => {
      const msg = classifyError(err);
      console.error("[ChatPanel] useChat error:", msg, err);
      errorCountRef.current += 1;
      if (errorCountRef.current >= 2) {
        onLLMError(msg);
      } else {
        setInlineError(msg);
      }
    },
  });

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-send initial brief once
  useEffect(() => {
    if (initialBrief && !hasAutoSent.current && messages.length === 0) {
      hasAutoSent.current = true;
      sendMessage({ text: initialBrief });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || status === "streaming" || status === "submitted") return;
    setInput("");
    setCharCount(0);
    setInlineError(null);
    errorCountRef.current = 0;
    sendMessage({ text });
  }, [input, status, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isLoading = status === "streaming" || status === "submitted";

  return (
    <div className="flex flex-col h-full">
      {/* Inline error banner */}
      {inlineError && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <span className="flex-1">⚠️ {inlineError}</span>
          <button
            onClick={() => setInlineError(null)}
            className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {messages.length === 0 && !isLoading && (
          <div className="text-center text-muted-foreground text-sm py-12">
            <div className="text-2xl mb-2">✍️</div>
            <p className="font-medium">Describe your project</p>
            <p className="text-xs mt-1 max-w-xs mx-auto">
              Tell the AI what you want to build, your timeline, and budget.
              It will create a structured plan with milestones.
            </p>
          </div>
        )}

        {messages.map((msg) => {
          const parts = Array.isArray(msg.parts) ? msg.parts as Array<{ type?: string; text?: string }> : [];
          const textContent = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("")
            .replace(/<user_brief>\n?/g, "")
            .replace(/\n?<\/user_brief>/g, "");

          const isUser = msg.role === "user";
          const isAI = msg.role === "assistant";

          // Detect a JSON fence in this message regardless of streaming state.
          // This is used to hide the raw JSON block even while it is still streaming.
          const hasFence = isAI && messageHasJsonFence(textContent);

          // Only attempt to parse + show the Approve button once streaming is done.
          const plan = isAI && status !== "streaming" && status !== "submitted"
            ? extractPlanFromMessage(textContent)
            : null;

          // Build the visible text:
          //   - If a complete parseable plan exists: strip the entire ```json…``` block.
          //   - If the fence exists but JSON isn't parseable yet (still streaming or truncated):
          //     strip everything from ```json onward so raw JSON is never visible.
          //   - Otherwise: show full text.
          const displayText = (() => {
            if (plan) {
              // Complete plan parsed — strip the fence block, keep surrounding text
              return textContent.replace(/```json[\s\S]*?```/g, "").trim();
            }
            if (hasFence) {
              // Fence opened but not yet closed (streaming) — hide from ```json onward
              return textContent.replace(/```json[\s\S]*/g, "").trim();
            }
            return textContent;
          })();

          const alreadySaved = savedMessageIds.has(msg.id);

          return (
            <div key={msg.id} className={`flex gap-2 items-start ${isUser ? "flex-row-reverse" : ""}`}>
              {/* Avatar */}
              <div className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-medium ${
                isUser ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}>
                {isUser ? "You" : "AI"}
              </div>

              <div className={`max-w-[80%] space-y-1 ${isUser ? "items-end" : "items-start"}`}>
                {displayText && (
                  <div className={`rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    isUser
                      ? "bg-primary text-primary-foreground ml-auto"
                      : "bg-muted text-foreground"
                  }`}>
                    {displayText}
                  </div>
                )}

                {/* While the JSON fence is streaming: show a subtle "Generating plan…" indicator */}
                {hasFence && !plan && (status === "streaming" || status === "submitted") && (
                  <div className="rounded-xl px-3 py-2 text-xs text-muted-foreground bg-muted/50 flex items-center gap-2">
                    <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    Generating plan…
                  </div>
                )}

                {/* Approve button — only on AI messages with a parseable plan */}
                {plan && !alreadySaved && (
                  <ApprovePlanButton
                    plan={plan}
                    projectId={projectId}
                    agentSessionId={agentSessionId}
                    onSaved={(savedPlan, milestoneCount, downgradedCriteria) => {
                      setSavedMessageIds((prev) => new Set(prev).add(msg.id));
                      onPlanUpdate(savedPlan);
                      if (downgradedCriteria.length > 0) {
                        setInlineError(`${downgradedCriteria.length} acceptance criteria were flagged for human review.`);
                      }
                      console.log("[ChatPanel] plan saved:", { milestoneCount, downgradedCriteria });
                    }}
                    onError={(errMsg) => {
                      setInlineError(errMsg);
                    }}
                  />
                )}

                {/* Already-saved badge (persists after approval) */}
                {plan && alreadySaved && (
                  <Badge className="text-xs bg-emerald-600 hover:bg-emerald-700 mt-1">
                    ✅ Plan saved — {plan.milestones.length} milestones
                  </Badge>
                )}
              </div>
            </div>
          );
        })}

        {isLoading && (
          <div className="flex gap-2 items-start">
            <div className="w-6 h-6 rounded-full bg-primary/10 flex-shrink-0 flex items-center justify-center text-xs">
              AI
            </div>
            <div className="space-y-1.5 flex-1">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t p-3 space-y-2 bg-background">
        {charCount > BRIEF_LIMITS.INPUT_MAX_CHARS * 0.9 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {charCount}/{BRIEF_LIMITS.INPUT_MAX_CHARS} characters
          </p>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => {
              const val = e.target.value.slice(0, BRIEF_LIMITS.INPUT_MAX_CHARS);
              setInput(val);
              setCharCount(val.length);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Describe your project…"
            rows={3}
            disabled={isLoading}
            className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 transition-opacity"
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            size="sm"
            className="self-end"
          >
            {isLoading ? (
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Thinking
              </span>
            ) : (
              "Send"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
