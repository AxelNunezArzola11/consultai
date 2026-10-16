"use client";

/**
 * ChatPanel — BriefAgent chat UI.
 *
 * Uses AI SDK v6 useChat from @ai-sdk/react.
 * In v6:
 *   - useChat takes a `transport` option (DefaultChatTransport) not `api: string` directly
 *   - OR pass `ChatInit` options including `transport`
 *   - sendMessage({ text }) is used (not handleSubmit)
 *   - onFinish receives { message, messages } not just message
 *
 * The route at /api/agent/brief returns a UIMessageStream response.
 * The useChat hook uses DefaultChatTransport to communicate with it.
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

    // The DefaultChatTransport throws new Error(await response.text()).
    // The response body may be our JSON error envelope {"error":"..."}.
    // Try to extract the human-readable message from it.
    let msg = raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.error === "string" && parsed.error) {
        msg = parsed.error;
      }
    } catch {
      // not JSON — use raw message
    }

    // ERR_NETWORK_CHANGED / Failed to fetch / NetworkError
    if (
      msg.includes("ERR_NETWORK_CHANGED") ||
      msg.includes("Failed to fetch") ||
      msg.includes("NetworkError") ||
      msg.includes("network")
    ) {
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
        // Escalate to parent fallback editor after 2 consecutive failures
        onLLMError(msg);
      } else {
        // Show inline dismissible banner — user can retry
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
    // Clear inline error and reset counter on new send
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

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

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

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

interface MessagePart {
  type?: string;
  text?: string;
  toolName?: string;
  state?: string;
  result?: {
    success?: boolean;
    milestoneCount?: number;
    downgradedCriteria?: string[];
  };
}

function MessageBubble({ message }: { message: { id: string; role: string; parts: MessagePart[] } }) {
  const isUser = message.role === "user";
  const parts: MessagePart[] = Array.isArray(message.parts) ? message.parts : [];

  // Extract text content
  const textContent = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");

  // Tool invocations
  const toolParts = parts.filter((p) => p.type === "tool-invocation");

  return (
    <div className={`flex gap-2 items-start ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-medium ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {isUser ? "You" : "AI"}
      </div>

      <div className={`max-w-[80%] space-y-1 ${isUser ? "items-end" : "items-start"}`}>
        {/* Text — strip XML delimiters */}
        {textContent && (
          <div
            className={`rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
              isUser
                ? "bg-primary text-primary-foreground ml-auto"
                : "bg-muted text-foreground"
            }`}
          >
            {textContent
              .replace(/<user_brief>\n?/g, "")
              .replace(/\n?<\/user_brief>/g, "")}
          </div>
        )}

        {/* Tool call badges */}
        {toolParts.map((p, i) => (
          <ToolInvocationBadge key={i} part={p} />
        ))}
      </div>
    </div>
  );
}

function ToolInvocationBadge({ part }: { part: MessagePart }) {
  if (part.toolName === "askClarification") {
    return (
      <Badge variant="outline" className="text-xs">
        💬 Asking clarification…
      </Badge>
    );
  }

  if (part.toolName === "saveStructuredBrief") {
    if (part.state === "call") {
      return (
        <Badge variant="outline" className="text-xs animate-pulse">
          💾 Saving plan…
        </Badge>
      );
    }
    if (part.state === "result" && part.result?.success) {
      return (
        <div className="space-y-1">
          <Badge variant="default" className="text-xs bg-emerald-600 hover:bg-emerald-700">
            ✅ Plan saved — {part.result.milestoneCount} milestones
          </Badge>
          {(part.result.downgradedCriteria?.length ?? 0) > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              ⚠️ {part.result.downgradedCriteria?.length} criteria need human review
            </p>
          )}
        </div>
      );
    }
    if (part.state === "result" && !part.result?.success) {
      return (
        <Badge variant="destructive" className="text-xs">
          ❌ Plan validation failed
        </Badge>
      );
    }
  }

  return null;
}
