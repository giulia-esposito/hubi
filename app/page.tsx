"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { groupSources } from "../lib/ui/sourceDisplay.ts";
import { FEEDBACK_TAGS, FEEDBACK_TAG_LABELS, type FeedbackTag } from "../lib/runtime/feedbackTags.ts";
import { CONVERSATION_TTL_MS, clearConversation, loadConversation, saveConversation, type KeyValueStore } from "../lib/runtime/conversationStore.ts";

type TurnKind = "grounded-answer" | "clarifying-question" | "no-grounded-answer" | "unknown";

interface SourceRef {
  documentTitle: string;
  heading: string | null;
  citationUrl: string | null;
  /** Region label from source metadata: Global, a named region, or "not specified in source metadata". */
  regionLabel?: string;
  /** The Content Registry's caveat for an Eligible with Restrictions source. */
  restriction?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sources?: SourceRef[];
  turnKind?: TurnKind;
  interactionId?: string;
  /** When the answer finished, for the AI-draft label (tool and date, ISSTD28 5.3). */
  finishedAt?: string;
  isStreaming?: boolean;
  error?: string;
  feedback?: { helpful: boolean; submitted: boolean };
  showCommentBox?: boolean;
  /** The server is buffering this answer for the pilot claim check: nothing streams until it is complete. */
  buffered?: boolean;
  /** performance.now() when the question was sent. */
  sentAt?: number;
  /** Milliseconds from sending the question to the first visible text. */
  waitMs?: number;
  /** planningMode reported for this answer; sent back so a short follow-up can continue an artifact request. */
  planningMode?: string;
  /** Region and country in force after this answer; sent back so they outlive the history window. */
  pinned?: { regions: string[]; countries: string[] };
  /** Set when the server's history caps left earlier turns out of this answer's context. */
  historyNotice?: { droppedOldest: number; truncatedTurns: number };
}

// Continuity does not depend on a Cloud Run instance: every request carries the prior turns.
// More than the server keeps (24), so the server can tell the user when it had to drop turns.
const MAX_HISTORY_SENT = 48;

// The conversation is kept in this browser for a while (lib/runtime/conversationStore.ts) so a reload does not lose it.
// Storage can be unavailable (private mode, blocked site data): then the conversation simply is not kept.
const NO_STORE: KeyValueStore = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };

function browserStore(): KeyValueStore {
  try {
    return window.localStorage;
  } catch {
    return NO_STORE;
  }
}

const TTL_HOURS = Math.round(CONVERSATION_TTL_MS / 3_600_000);

// Starting points on the first screen: tool usage, a process, a concept and an internal rule. Each was tried against
// the pilot corpus on 2026-11-06 and answered from one to four relevant sources. Re-check them when content is added.
const EXAMPLE_QUESTIONS = [
  "How do I use Activities and Chatter in Salesforce?",
  "What are the best practices for reps using Salesloft?",
  "What is client segmentation by contract adherence?",
  "What are the Rules of Engagement?",
];

// While the service loads its knowledge after an update, the first question can take up to about 30 seconds. Asking the
// health endpoint on open lets the page say so before anyone types. Failing to reach it just means no banner.
function useKnowledgeReady(): boolean {
  const [ready, setReady] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = await res.json();
        const status = body?.knowledgeBase?.status;
        if (cancelled) return;
        // Only "loading" is a wait. "not-started" (local development) loads on the first question, so no banner.
        if (status === "loading") {
          setReady(false);
          timer = setTimeout(check, 3000);
        } else setReady(true);
      } catch {
        if (!cancelled) setReady(true);
      }
    }
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return ready;
}

// Says what is happening while an answer is on its way, in steps so a long wait is never a silent one.
function WaitStatus({ sentAt, buffered }: { sentAt?: number; buffered?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = sentAt ?? performance.now();
    const id = setInterval(() => setElapsed(performance.now() - start), 1000);
    return () => clearInterval(id);
  }, [sentAt]);
  let label = "Searching the knowledge base";
  if (elapsed > 4000) label = buffered ? "Drafting the answer and checking it against the sources" : "Preparing your answer";
  if (elapsed > 12000) label = "Still working. The first question after an update can take up to 30 seconds";
  return (
    <span className="wait-status" role="status">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label}
    </span>
  );
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

// One row per document, collapsed by default. Region and eligibility metadata stay in the logs; the only caveat shown
// outside the collapsed list is a registry usage restriction, because a reader must see it before reusing the content.
function SourcesList({ sources }: { sources: SourceRef[] }) {
  const rows = groupSources(sources);
  if (rows.length === 0) return null;
  const restricted = rows.filter((r) => r.restriction);
  return (
    <div className="sources">
      {restricted.map((r) => (
        <div key={r.title} className="source-restriction">
          Usage note for {r.title}: {r.restriction}
        </div>
      ))}
      <details>
        <summary>
          Sources ({rows.length})
        </summary>
        <ul>
          {rows.map((r) => (
            <li key={r.title}>
              {r.url ? (
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.title}
                </a>
              ) : (
                <span>{r.title} (no link available)</span>
              )}
              {r.sections.length > 0 && <span className="source-sections">{r.sections.join(" · ")}</span>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const THUMB_UP = "M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Zm0 0 3.5-7a2 2 0 0 1 2 2v3.5h5.2a2 2 0 0 1 2 2.3l-1.1 6.5a2 2 0 0 1-2 1.7H7";
const THUMB_DOWN = "M17 13V4h3a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-3Zm0 0-3.5 7a2 2 0 0 1-2-2v-3.5H6.3a2 2 0 0 1-2-2.3l1.1-6.5a2 2 0 0 1 2-1.7H17";

function ThumbIcon({ path }: { path: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function Feedback({
  message,
  onSubmit,
}: {
  message: ChatMessage;
  onSubmit: (helpful: boolean, comment?: string, tags?: FeedbackTag[]) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [comment, setComment] = useState("");
  const [tags, setTags] = useState<FeedbackTag[]>([]);

  if (message.feedback?.submitted) {
    return <div className="feedback-thanks">Thanks, that helps us improve Hubi.</div>;
  }

  function toggleTag(tag: FeedbackTag) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  // The wait is recorded with every vote (waitMs), so "helpful but slow" needs no button of its own.
  return (
    <div className="feedback-block">
      <div className="feedback">
        <span className="feedback-prompt">Was this helpful?</span>
        <button type="button" onClick={() => onSubmit(true)} aria-label="Helpful">
          <ThumbIcon path={THUMB_UP} /> Helpful
        </button>
        <button type="button" className={showDetails ? "active" : ""} onClick={() => setShowDetails(true)} aria-label="Not helpful" aria-expanded={showDetails}>
          <ThumbIcon path={THUMB_DOWN} /> Not helpful
        </button>
      </div>
      {showDetails && (
        <div className="feedback-panel">
          <p className="feedback-panel-title">What went wrong? Pick any that apply.</p>
          <div className="feedback-tags">
            {FEEDBACK_TAGS.map((tag) => (
              <button key={tag} type="button" className={tags.includes(tag) ? "tag selected" : "tag"} aria-pressed={tags.includes(tag)} onClick={() => toggleTag(tag)}>
                {FEEDBACK_TAG_LABELS[tag]}
              </button>
            ))}
          </div>
          <textarea placeholder="Tell us more (optional)" aria-label="Tell us more" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="feedback-actions">
            <button type="button" className="feedback-send" onClick={() => onSubmit(false, comment.trim() || undefined, tags)}>
              Send feedback
            </button>
            <button type="button" className="feedback-cancel" onClick={() => setShowDetails(false)}>
              Cancel
            </button>
          </div>
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
  const [hydrated, setHydrated] = useState(false);
  const [restored, setRestored] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const knowledgeReady = useKnowledgeReady();

  // On open: restore the stored conversation if it is still inside its window, otherwise start a new one.
  useEffect(() => {
    const stored = loadConversation<ChatMessage>(browserStore(), Date.now());
    if (stored) {
      setSessionId(stored.id);
      setMessages(stored.messages);
      setRestored(true);
    } else {
      setSessionId(crypto.randomUUID());
    }
    setHydrated(true);
  }, []);

  // Keep the stored copy current; each save pushes the inactivity window out. A half-written answer is never stored.
  useEffect(() => {
    if (hydrated && sessionId) saveConversation(browserStore(), sessionId, messages, Date.now());
  }, [hydrated, sessionId, messages]);

  useEffect(() => {
    if (messages.length > 0) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // The only deliberate way to lose context before the window expires.
  function handleNewConversation() {
    clearConversation(browserStore());
    setSessionId(crypto.randomUUID());
    setMessages([]);
    setRestored(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void sendQuestion(input.trim());
  }

  async function sendQuestion(question: string) {
    if (!question || isStreaming || !sessionId) return;

    // The conversation travels with the request (see lib/runtime/requestSession.ts).
    const history = messages
      .filter((m) => !m.error && m.text.trim())
      .slice(-MAX_HISTORY_SENT)
      .map((m) => ({ role: m.role, content: m.text }));
    const lastPlanningMode = [...messages].reverse().find((m) => m.role === "assistant" && !m.error && m.planningMode)?.planningMode;
    const pinned = [...messages].reverse().find((m) => m.role === "assistant" && !m.error && m.pinned)?.pinned;

    setInput("");
    setRestored(false);
    setIsStreaming(true);
    setMessages((prev) => [...prev, { role: "user", text: question }, { role: "assistant", text: "", isStreaming: true, sentAt: performance.now() }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, question, history, lastPlanningMode, pinned }),
      });

      if (res.status === 429) throw new Error("rate-limited");
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
        const tooFast = err instanceof Error && err.message === "rate-limited";
        next[lastIndex] = { ...last, isStreaming: false, error: tooFast ? "You are sending messages faster than Hubi can handle -- wait a few seconds and try again." : "Hubi is currently unavailable -- please retry." };
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
        updated = { ...last, sources: event.sources, buffered: Boolean(event.buffered), historyNotice: event.historyNotice };
      } else if (event.type === "delta") {
        const firstText = last.waitMs === undefined && last.sentAt !== undefined && event.text;
        updated = { ...last, text: last.text + event.text, waitMs: firstText ? Math.round(performance.now() - (last.sentAt as number)) : last.waitMs };
      } else if (event.type === "done") {
        updated = event.ok
          ? { ...last, isStreaming: false, turnKind: event.turnKind, planningMode: event.planningMode, pinned: event.pinned, interactionId: event.interactionId, finishedAt: new Date().toISOString() }
          : { ...last, isStreaming: false, error: "Hubi is currently unavailable -- please retry." };
      } else {
        return prev;
      }

      const next = [...prev];
      next[lastIndex] = updated;
      return next;
    });
  }

  async function submitFeedback(index: number, helpful: boolean, comment?: string, tags?: FeedbackTag[]) {
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
      body: JSON.stringify({
        sessionId,
        interactionId: message.interactionId,
        helpful,
        comment,
        tags,
        waitMs: message.waitMs,
        buffered: message.buffered,
      }),
    }).catch(() => {
      // Best-effort logging for an internal prototype -- a failed feedback
      // POST shouldn't disrupt the conversation.
    });
  }

  return (
    <main className="page">
      <header className="page-header">
        <div className="brand">
          <img className="brand-logo" src="/brand/wellhub-logo-magenta.png" alt="Wellhub" width={113} height={22} />
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-product">Hubi</span>
          <span className="pilot-chip">Pilot</span>
        </div>
        <button className="new-session-button" onClick={handleNewConversation}>
          New conversation
        </button>
      </header>

      {!knowledgeReady && (
        <div className="ready-banner" role="status">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Hubi is getting its knowledge ready. This takes up to 30 seconds after an update, and you can type your question meanwhile.
        </div>
      )}

      <div className="messages">
        {restored && messages.length > 0 && (
          <div className="history-notice">
            Continuing your conversation from earlier. It is kept for {TTL_HOURS} hours after your last message; choose New conversation to start fresh.
          </div>
        )}
        {messages.length === 0 && (
          <div className="empty-state">
            <h1>What are you working on?</h1>
            <p>Ask about Revenue processes, tools and playbooks. Answers come from approved Revenue knowledge.</p>
            <div className="example-questions">
              {EXAMPLE_QUESTIONS.map((q) => (
                <button key={q} type="button" className="example-question" disabled={isStreaming || !sessionId} onClick={() => void sendQuestion(q)}>
                  {q}
                </button>
              ))}
            </div>
            <details className="guidelines">
              <summary>Usage guidelines</summary>
              <ul>
                <li>Do not enter personal data (names, emails, phone numbers) or confidential client information.</li>
                <li>Pitches and emails are AI-generated drafts: review figures and claims against the cited sources before using or sharing them.</li>
              </ul>
            </details>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role} ${turnKindClassName(m.turnKind)}`}>
            <div className="bubble">
              {m.text ? (
                m.role === "assistant" ? <MarkdownMessage text={m.text} /> : m.text
              ) : (
                m.isStreaming ? <WaitStatus sentAt={m.sentAt} buffered={m.buffered} /> : ""
              )}
            </div>
            {m.role === "assistant" && turnKindLabel(m.turnKind) && (
              <span className={`turn-kind-badge ${turnKindClassName(m.turnKind)}`}>{turnKindLabel(m.turnKind)}</span>
            )}
            {m.role === "assistant" && !m.isStreaming && !m.error && m.planningMode === "business-assistance" && m.finishedAt && (
              <div className="ai-draft-label">
                AI-generated draft by Hubi · {new Date(m.finishedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}. Review figures and claims against the cited sources before using or sharing.
              </div>
            )}
            {m.role === "assistant" && m.error && <div className="error-banner">{m.error}</div>}
            {m.role === "assistant" && m.historyNotice && (
              <div className="history-notice">
                Earlier messages in this conversation were left out of this answer's context ({m.historyNotice.droppedOldest} turn
                {m.historyNotice.droppedOldest === 1 ? "" : "s"}). Restate anything important, or start a new session.
              </div>
            )}
            {m.role === "assistant" && !m.isStreaming && m.sources && <SourcesList sources={m.sources} />}
            {m.role === "assistant" && !m.isStreaming && !m.error && (
              <Feedback message={m} onSubmit={(helpful, comment, tags) => submitFeedback(i, helpful, comment, tags)} />
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <form onSubmit={handleSubmit}>
          <textarea
            rows={1}
            placeholder="Ask Hubi about Revenue work"
            aria-label="Your question"
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
        <p className="composer-note">Hubi can make mistakes. Check the sources before sharing anything with a client.</p>
      </div>
    </main>
  );
}
