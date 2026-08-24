"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type TurnKind = "grounded-answer" | "clarifying-question" | "no-grounded-answer" | "unknown";

interface SourceRef {
  documentTitle: string;
  heading: string | null;
  citationUrl: string | null;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sources?: SourceRef[];
  turnKind?: TurnKind;
  interactionId?: string;
  isStreaming?: boolean;
  error?: string;
  feedback?: { helpful: boolean; submitted: boolean };
  showCommentBox?: boolean;
}

const SESSION_STORAGE_KEY = "hubi-session-id";

function getOrCreateBrowserSessionId(): string {
  const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
  return fresh;
}

function turnKindClassName(turnKind: TurnKind | undefined): string {
  if (turnKind === "clarifying-question") return "clarifying-question";
  if (turnKind === "no-grounded-answer") return "no-grounded-answer";
  return ""; // grounded-answer and unknown both render as the neutral default
}

function turnKindLabel(turnKind: TurnKind | undefined): string | null {
  if (turnKind === "clarifying-question") return "Hubi needs more context";
  if (turnKind === "no-grounded-answer") return "No grounded answer found";
  return null;
}

// Renders assistant text as Markdown. Deliberately does NOT enable the
// rehype-raw plugin, which is what would let react-markdown parse embedded
// HTML tags in the source into real DOM nodes -- without it, anything that
// looks like an HTML/script tag in a model response is treated as literal
// text, never executed. That's the actual XSS boundary here, not a sanitizer
// bolted on afterward.
function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        table: ({ node, ...props }) => (
          <div className="md-table-wrap">
            <table {...props} />
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function SourcesList({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="sources">
      {sources.map((s, i) => {
        const locator = s.heading ? `${s.documentTitle} -- ${s.heading}` : s.documentTitle;
        return (
          <div key={i}>
            {s.citationUrl ? (
              <a href={s.citationUrl} target="_blank" rel="noreferrer">
                {locator}
              </a>
            ) : (
              <span>{locator} (no link available)</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Feedback({
  message,
  onSubmit,
}: {
  message: ChatMessage;
  onSubmit: (helpful: boolean, comment?: string) => void;
}) {
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState("");

  if (message.feedback?.submitted) {
    return <div className="feedback-thanks">Thanks for the feedback.</div>;
  }

  return (
    <div>
      <div className="feedback">
        <button onClick={() => onSubmit(true)}>Helpful</button>
        <button onClick={() => setShowComment(true)}>Not helpful</button>
      </div>
      {showComment && (
        <div className="feedback-comment">
          <textarea
            placeholder="Optional: what was wrong? (not required)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <button onClick={() => onSubmit(false, comment.trim() || undefined)}>Send</button>
        </div>
      )}
    </div>
  );
}

export default function ChatPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSessionId(getOrCreateBrowserSessionId());
  }, []);

  useEffect(() => {
    if (messages.length > 0) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleNewSession() {
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    setSessionId(fresh);
    setMessages([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || isStreaming || !sessionId) return;

    setInput("");
    setIsStreaming(true);
    setMessages((prev) => [...prev, { role: "user", text: question }, { role: "assistant", text: "", isStreaming: true }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, question }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          applyEvent(event);
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const lastIndex = prev.length - 1;
        const last = prev[lastIndex];
        if (last?.role !== "assistant") return prev;
        const next = [...prev];
        next[lastIndex] = { ...last, isStreaming: false, error: "Hubi is currently unavailable -- please retry." };
        return next;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  // Always returns a new array with a new message object for the updated
  // slot -- never mutates the previous message in place. React 18+ Strict
  // Mode (on by default under `next dev`) double-invokes setState updater
  // functions in development to catch exactly this: an in-place mutation
  // (e.g. `last.text += event.text`) gets applied twice to the same shared
  // object, silently duplicating every streamed delta.
  function applyEvent(event: any) {
    setMessages((prev) => {
      const lastIndex = prev.length - 1;
      const last = prev[lastIndex];
      if (!last || last.role !== "assistant") return prev;

      let updated: ChatMessage;
      if (event.type === "retrieval") {
        updated = { ...last, sources: event.sources };
      } else if (event.type === "delta") {
        updated = { ...last, text: last.text + event.text };
      } else if (event.type === "done") {
        updated = event.ok
          ? { ...last, isStreaming: false, turnKind: event.turnKind, interactionId: event.interactionId }
          : { ...last, isStreaming: false, error: "Hubi is currently unavailable -- please retry." };
      } else {
        return prev;
      }

      const next = [...prev];
      next[lastIndex] = updated;
      return next;
    });
  }

  async function submitFeedback(index: number, helpful: boolean, comment?: string) {
    const message = messages[index];
    if (!message?.interactionId || !sessionId) return;

    setMessages((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], feedback: { helpful, submitted: true } };
      return next;
    });

    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, interactionId: message.interactionId, helpful, comment }),
    }).catch(() => {
      // Best-effort logging for an internal prototype -- a failed feedback
      // POST shouldn't disrupt the conversation.
    });
  }

  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Hubi</h1>
          <p>Wellhub Revenue's AI Copilot -- internal prototype</p>
        </div>
        <button className="new-session-button" onClick={handleNewSession}>
          New session
        </button>
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">Ask a Revenue question to get started.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role} ${turnKindClassName(m.turnKind)}`}>
            <div className="bubble">
              {m.text ? (
                m.role === "assistant" ? <MarkdownMessage text={m.text} /> : m.text
              ) : (
                m.isStreaming ? "..." : ""
              )}
            </div>
            {m.role === "assistant" && turnKindLabel(m.turnKind) && (
              <span className={`turn-kind-badge ${turnKindClassName(m.turnKind)}`}>{turnKindLabel(m.turnKind)}</span>
            )}
            {m.role === "assistant" && m.error && <div className="error-banner">{m.error}</div>}
            {m.role === "assistant" && !m.isStreaming && m.sources && <SourcesList sources={m.sources} />}
            {m.role === "assistant" && !m.isStreaming && !m.error && (
              <Feedback message={m} onSubmit={(helpful, comment) => submitFeedback(i, helpful, comment)} />
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <form onSubmit={handleSubmit}>
          <textarea
            rows={1}
            placeholder="Ask Hubi a Revenue question..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as React.FormEvent);
              }
            }}
          />
          <button type="submit" disabled={isStreaming || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </main>
  );
}
