"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

interface GanttChatPanelProps {
  onAiMessage?: (message: string) => Promise<string>;
}

export default function GanttChatPanel({ onAiMessage }: GanttChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    setError(null);
    setMessages((current) => [
      ...current,
      { id: Date.now(), role: "user", text },
    ]);
    setIsLoading(true);

    try {
      const response = onAiMessage
        ? await onAiMessage(text)
        : "The scheduling assistant is not configured yet.";
      setMessages((current) => [
        ...current,
        { id: Date.now() + 1, role: "assistant", text: response },
      ]);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The AI request failed.";
      console.error("[GanttChatPanel] AI request failed:", reason);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, onAiMessage]);

  return (
    <div className="mx-3 mt-2 flex max-h-[360px] min-h-[280px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/50">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-4 py-2.5">
        <div>
          <p className="text-sm font-semibold text-slate-100">✦ AI Copilot</p>
          <p className="text-[11px] text-slate-500">Ask about your project schedule</p>
        </div>
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">
          Ready
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="py-6 text-center text-xs text-slate-400">
            <p className="font-medium text-slate-200">How can I help plan your work?</p>
            <p className="mx-auto mt-1 max-w-sm">
              Try &quot;add a client review milestone&quot; or &quot;delay QA by three days&quot;.
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex gap-2 ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-5 ${
                message.role === "user"
                  ? "bg-blue-600 text-white"
                  : "border border-slate-700 bg-slate-800 text-slate-200"
              }`}
            >
              {message.role === "assistant" ? (
                <ReactMarkdown>{message.text}</ReactMarkdown>
              ) : (
                message.text
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="text-xs text-slate-500">Scheduling assistant is thinking…</div>
        )}
        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-slate-800 p-3">
        <div className="flex items-end gap-2 rounded-xl border border-slate-700 bg-slate-950 p-2 focus-within:border-slate-500">
          <textarea
            value={input}
            rows={1}
            disabled={isLoading}
            placeholder="Ask the scheduling assistant..."
            aria-label="Message the scheduling assistant"
            className="max-h-20 min-h-7 flex-1 resize-none bg-transparent px-1 py-1 text-xs text-slate-100 outline-none placeholder:text-slate-600"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
          />
          <button
            type="button"
            disabled={isLoading || !input.trim()}
            onClick={() => void handleSend()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
