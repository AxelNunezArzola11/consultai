"use client";

/**
 * PaymentChatPanel — Chat-driven payment interface.
 *
 * Allows the company to:
 * - Query milestone payment status via natural language
 * - See pending approvals that need action
 * - Trigger payout approval directly from chat
 *
 * Uses AI SDK v6 useChat with DefaultChatTransport.
 * The /api/agent/payment-chat endpoint handles the AI streaming.
 *
 * Tool action handling:
 * - When the AI calls requestPayoutApproval and returns success: true,
 *   an interactive card appears in the chat for the company to confirm and execute the payout.
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// ── Types ──────────────────────────────────────────────────────────────────

interface PaymentChatPanelProps {
  projectId: string;
  /** Milestone summaries for context shown in the chat header */
  milestones?: Array<{
    id: string;
    title: string;
    status: string;
    budgetUsd: string;
  }>;
}

interface PayoutAction {
  milestoneId: string;
  milestoneTitle: string;
  captureNetUsd: string | null;
  paymentId: string | null;
  recipientEmail: string;
  note: string | null;
}

type MessagePart = {
  type?: string;
  text?: string;
  toolName?: string;
  state?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
};

// ── Error classifier ───────────────────────────────────────────────────────

function classifyError(err: unknown): string {
  if (err instanceof Error) {
    const raw = err.message;
    // The DefaultChatTransport throws new Error(await response.text()).
    // Extract human-readable message from our JSON error envelope if present.
    let msg = raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.error === "string" && parsed.error) {
        msg = parsed.error;
      }
    } catch {
      // not JSON — use raw
    }

    if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("ERR_NETWORK_CHANGED") || msg.includes("network")) {
      return "Network error — check your connection and retry.";
    }
    if (msg.includes("403") || msg.includes("Forbidden")) {
      return "Access denied. You must be logged in as a company user.";
    }
    if (msg.includes("503") || msg.includes("not configured") || msg.includes("GROQ_API_KEY") || msg.includes("not set")) {
      return "AI service is not configured. Contact support.";
    }
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("Rate limit")) {
      return "Rate limit reached. Please wait before sending more messages.";
    }
    return msg || "An unexpected error occurred.";
  }
  return "An unexpected error occurred.";
}

// ── Component ──────────────────────────────────────────────────────────────

export function PaymentChatPanel({ projectId, milestones }: PaymentChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pendingPayoutAction, setPendingPayoutAction] = useState<PayoutAction | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(false);

  const transport = useRef(
    new DefaultChatTransport({
      api: "/api/agent/payment-chat",
      body: { projectId },
    })
  ).current;

  const { messages, sendMessage, status } = useChat({
    transport,
    onError: (err) => {
      const msg = classifyError(err);
      console.error("[PaymentChatPanel] error:", msg, err);
      setInlineError(msg);
    },
  });

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Watch for requestPayoutApproval tool results
  useEffect(() => {
    for (const msg of messages) {
      const parts: MessagePart[] = Array.isArray(msg.parts) ? msg.parts as MessagePart[] : [];
      for (const part of parts) {
        if (
          part.type === "tool-invocation" &&
          part.toolName === "requestPayoutApproval" &&
          part.state === "result" &&
          part.output
        ) {
          const output = part.output as Record<string, unknown>;
          if (output.success && output.action === "payout_requested" && !pendingPayoutAction) {
            setPendingPayoutAction({
              milestoneId: String(output.milestoneId ?? ""),
              milestoneTitle: String(output.milestoneTitle ?? ""),
              captureNetUsd: output.captureNetUsd ? String(output.captureNetUsd) : null,
              paymentId: output.paymentId ? String(output.paymentId) : null,
              recipientEmail: String(output.recipientEmail ?? ""),
              note: output.note ? String(output.note) : null,
            });
          }
        }
      }
    }
  // Only re-run when messages change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || status === "streaming" || status === "submitted") return;
    setInput("");
    setInlineError(null);
    sendMessage({ text });
  }, [input, status, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Execute payout via the existing API
  const handleExecutePayout = useCallback(async () => {
    if (!pendingPayoutAction) return;
    setPayoutLoading(true);
    try {
      const res = await fetch("/api/paypal/payout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: pendingPayoutAction.paymentId,
          milestoneId: pendingPayoutAction.milestoneId,
          recipientEmail: pendingPayoutAction.recipientEmail,
          note: pendingPayoutAction.note,
        }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        toast.error(`Payout failed: ${String(data.error ?? "unknown error")}`);
      } else if (data.status === "pending_approval") {
        toast.info("Approval required — amount exceeds auto-approve threshold.");
      } else {
        toast.success(
          data.isReplay
            ? "↩ Idempotent replay — original payout, no double payment"
            : `Payout submitted — batch ${String(data.batchId ?? "")}`
        );
      }
      setPendingPayoutAction(null);
    } catch {
      toast.error("Network error — payout request failed.");
    } finally {
      setPayoutLoading(false);
    }
  }, [pendingPayoutAction]);

  const isLoading = status === "streaming" || status === "submitted";

  // Quick-action buttons — pre-fill the input
  const quickActions = [
    { label: "Show all milestones", text: "Show me all milestones and their payment status." },
    { label: "Pending approvals", text: "Are there any pending payout approvals that need my action?" },
    ...(milestones
      ?.filter((m) => m.status === "funded")
      .slice(0, 2)
      .map((m) => ({
        label: `Pay out: ${m.title}`,
        text: `I want to pay out milestone "${m.title}" (${m.id}).`,
      })) ?? []),
  ];

  return (
    <div className="flex flex-col h-full rounded-2xl overflow-hidden border border-slate-800 bg-slate-900 shadow-2xl shadow-black/50">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-950/60 flex-shrink-0">
        <p className="text-sm font-semibold text-slate-100">Payment Assistant</p>
        <p className="text-xs text-slate-400 mt-0.5">
          Ask about milestones, trigger payouts, or handle approvals in chat
        </p>
      </div>

      {/* Inline error */}
      {inlineError && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <span className="flex-1">⚠️ {inlineError}</span>
          <button onClick={() => setInlineError(null)} className="shrink-0 font-medium underline hover:no-underline transition-colors">
            Dismiss
          </button>
        </div>
      )}

      {/* Payout confirmation card */}
      {pendingPayoutAction && (
        <div className="mx-3 mt-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
          <p className="text-xs font-semibold text-emerald-400">
            💸 Payout ready to execute
          </p>
          <div className="text-xs text-emerald-300 space-y-0.5">
            <p><strong>Milestone:</strong> {pendingPayoutAction.milestoneTitle}</p>
            {pendingPayoutAction.captureNetUsd && (
              <p><strong>Amount:</strong> ${pendingPayoutAction.captureNetUsd}</p>
            )}
            <p><strong>Recipient:</strong> {pendingPayoutAction.recipientEmail}</p>
            {pendingPayoutAction.note && <p><strong>Note:</strong> {pendingPayoutAction.note}</p>}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-emerald-500"
              disabled={payoutLoading}
              onClick={handleExecutePayout}
            >
              {payoutLoading ? (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Processing…
                </span>
              ) : (
                "Confirm & Send Payout"
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-slate-100 rounded-xl transition-colors duration-200"
              disabled={payoutLoading}
              onClick={() => setPendingPayoutAction(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {messages.length === 0 && !isLoading && (
          <div className="text-center text-slate-400 text-sm py-8">
            <div className="text-2xl mb-2">💬</div>
            <p className="font-medium text-slate-100">Payment Assistant</p>
            <p className="text-xs mt-1 max-w-xs mx-auto text-slate-400">
              Ask about milestone statuses, trigger payouts, or check pending approvals.
            </p>

            {/* Quick action buttons */}
            {quickActions.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5 mt-4">
                {quickActions.map((qa, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setInput(qa.text);
                    }}
                    className="inline-flex text-xs rounded-full border border-slate-700 px-2.5 py-1 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors duration-200"
                  >
                    {qa.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((msg) => (
          <PaymentMessageBubble key={msg.id} message={msg as { id: string; role: string; parts: MessagePart[] }} />
        ))}

        {/* Thinking indicator — 3 pulsing dots */}
        {isLoading && (
          <div className="flex gap-2.5 items-start">
            <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-slate-300">
              AI
            </div>
            <div className="rounded-2xl rounded-tl-sm bg-slate-800 border border-slate-700 px-4 py-3 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: "0ms" }} />
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: "150ms" }} />
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: "300ms" }} />
              <span className="ml-1.5 text-xs text-slate-400">thinking…</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-800 p-3 space-y-2 bg-slate-900/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about payments, request a payout…"
            rows={2}
            disabled={isLoading}
            className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 focus:border-transparent disabled:opacity-50 transition-all duration-200"
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            size="sm"
            className="self-end bg-blue-600 hover:bg-blue-500 text-white rounded-xl focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 transition-colors duration-200 disabled:opacity-50"
          >
            {isLoading ? (
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Sending
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

// ── Message bubble ─────────────────────────────────────────────────────────

function PaymentMessageBubble({ message }: { message: { id: string; role: string; parts: MessagePart[] } }) {
  const isUser = message.role === "user";
  const parts: MessagePart[] = Array.isArray(message.parts) ? message.parts : [];

  const textContent = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");

  const toolParts = parts.filter((p) => p.type === "tool-invocation");

  return (
    <div className={`flex gap-2.5 items-start ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold tracking-wide ${
          isUser
            ? "bg-blue-600 text-white"
            : "bg-slate-800 border border-slate-700 text-slate-300"
        }`}
      >
        {isUser ? "You" : "AI"}
      </div>

      <div className={`max-w-[82%] space-y-1.5 ${isUser ? "items-end" : "items-start"}`}>
        {textContent && (
          <div
            className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              isUser
                ? "bg-blue-600 text-white ml-auto rounded-tr-sm"
                : "bg-slate-800 border border-slate-700 text-slate-100 rounded-tl-sm"
            }`}
          >
            {!isUser ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-1.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-1.5">{children}</ol>,
                  li: ({ children }) => <li className="text-slate-200">{children}</li>,
                  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                  code: ({ children, className }) => {
                    const isBlock = className?.includes("language-");
                    return isBlock
                      ? <code className="block bg-slate-950 rounded-lg p-4 text-xs font-mono text-slate-300 overflow-x-auto my-2">{children}</code>
                      : <code className="bg-slate-950 rounded px-1.5 py-0.5 text-xs font-mono text-blue-300">{children}</code>;
                  },
                  table: ({ children }) => <table className="text-xs border-collapse w-full my-2">{children}</table>,
                  th: ({ children }) => <th className="border border-slate-600 px-2 py-1 text-left font-semibold bg-slate-900">{children}</th>,
                  td: ({ children }) => <td className="border border-slate-700 px-2 py-1">{children}</td>,
                }}
              >
                {textContent}
              </ReactMarkdown>
            ) : (
              textContent
            )}
          </div>
        )}

        {toolParts.map((p, i) => (
          <PaymentToolBadge key={i} part={p} />
        ))}
      </div>
    </div>
  );
}

// ── Tool result badges ─────────────────────────────────────────────────────

function PaymentToolBadge({ part }: { part: MessagePart }) {
  if (!part.toolName) return null;

  if (part.state === "call") {
    const labels: Record<string, string> = {
      getMilestoneStatus: "🔍 Checking milestone…",
      listMilestones:     "📋 Loading milestones…",
      getPendingApprovals: "⏳ Checking approvals…",
      requestPayoutApproval: "💸 Preparing payout…",
    };
    return (
      <Badge variant="outline" className="text-xs animate-pulse">
        {labels[part.toolName] ?? `🔧 ${part.toolName}…`}
      </Badge>
    );
  }

  if (part.state === "result" && part.output) {
    const output = part.output as Record<string, unknown>;

    if (part.toolName === "listMilestones") {
      const mList = (output.milestones as Array<{ title: string; status: string; budgetUsd: string }> | null) ?? [];
      return (
        <div className="rounded-lg border bg-background p-2 space-y-1 text-xs max-w-sm">
          {mList.map((m, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <span className="truncate">{m.title}</span>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-muted-foreground">${m.budgetUsd}</span>
                <Badge variant="outline" className="text-[10px] h-4 px-1">
                  {m.status}
                </Badge>
              </div>
            </div>
          ))}
          {mList.length === 0 && <p className="text-muted-foreground">No milestones found.</p>}
        </div>
      );
    }

    if (part.toolName === "getPendingApprovals") {
      const pending = (output.pendingApprovals as Array<{ title: string; captureNetUsd: string | null }> | null) ?? [];
      const count = typeof output.count === "number" ? output.count : 0;
      return (
        <Badge
          variant={count > 0 ? "destructive" : "outline"}
          className="text-xs"
        >
          {count > 0
            ? `⚠️ ${count} approval${count !== 1 ? "s" : ""} pending`
            : "✓ No pending approvals"}
        </Badge>
      );
    }

    if (part.toolName === "requestPayoutApproval") {
      if (output.success) {
        return (
          <Badge variant="default" className="text-xs bg-emerald-600 hover:bg-emerald-700">
            ✓ Payout prepared — confirm above
          </Badge>
        );
      } else {
        return (
          <Badge variant="destructive" className="text-xs">
            ✗ {String(output.error ?? "Payout preparation failed")}
          </Badge>
        );
      }
    }

    if (part.toolName === "getMilestoneStatus") {
      if (!output.found) {
        return <Badge variant="outline" className="text-xs">Milestone not found</Badge>;
      }
      return (
        <div className="rounded-lg border bg-background px-2 py-1 text-xs space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium">{String(output.title ?? "")}</span>
            <Badge variant="outline" className="text-[10px] h-4 px-1">{String(output.status ?? "")}</Badge>
          </div>
          <p className="text-muted-foreground">
            Budget: ${String(output.budgetUsd ?? "0")}
            {output.captureNetUsd ? ` · Net: $${String(output.captureNetUsd)}` : null}
          </p>
        </div>
      );
    }
  }

  return null;
}
