import { PLANNING_MODES } from "./planningMode.ts";
import { createSession, type Session, type Turn } from "./sessionState.ts";

/**
 * Multi-turn continuity that does not depend on which Cloud Run instance
 * serves a request.
 *
 * The server used to keep each conversation in instance memory
 * (sessionRegistry.ts). With several instances and no session affinity, the
 * next turn could land on an instance that had never seen the conversation,
 * and the context silently reset. Now the browser, which already holds the
 * whole conversation, sends the prior turns with every request and the server
 * rebuilds the session from them: any instance can serve any turn, and nothing
 * is shared between instances.
 *
 * The history is supplied by the client, so it is validated and capped, and it
 * is treated as untrusted input exactly like the question itself: it can only
 * change the context of the conversation its own sender is having. A request
 * that sends no `history` at all (an older client) falls back to the
 * in-memory session, so nothing breaks during rollout.
 */

export const MAX_HISTORY_TURNS = 24;
export const MAX_TURN_CHARS = 8_000;
export const MAX_HISTORY_CHARS = 48_000;
export const MAX_QUESTION_CHARS = 4_000;

export interface ChatRequest {
  sessionId: string;
  question: string;
  /** Prior turns, oldest first. `undefined` means the client did not send history (fall back to server memory). */
  history?: Turn[];
  /** planningMode the previous assistant turn reported, so a short follow-up can continue an artifact request. */
  lastPlanningMode?: string;
}

export type ParsedChatRequest = { ok: true; value: ChatRequest } | { ok: false; error: string };

const KNOWN_MODES = new Set<string>(PLANNING_MODES);

/** Validates the history sent by the client; keeps the most recent turns within the caps. */
export function sanitizeHistory(raw: unknown): { ok: true; turns: Turn[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "history must be an array" };
  const turns: Turn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false, error: "history entries must be objects" };
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return { ok: false, error: "history roles must be user or assistant" };
    if (typeof content !== "string") return { ok: false, error: "history content must be a string" };
    const text = content.trim();
    if (!text) continue; // an empty turn (for example a failed answer) carries no context
    turns.push({ role, content: text.length > MAX_TURN_CHARS ? text.slice(0, MAX_TURN_CHARS) : text });
  }

  // Keep the most recent turns: first by count, then by total size.
  let kept = turns.slice(-MAX_HISTORY_TURNS);
  let total = kept.reduce((n, t) => n + t.content.length, 0);
  while (kept.length > 0 && total > MAX_HISTORY_CHARS) {
    total -= kept[0].content.length;
    kept = kept.slice(1);
  }
  // A conversation window must not start mid-exchange with an assistant turn.
  while (kept.length > 0 && kept[0].role === "assistant") kept = kept.slice(1);
  return { ok: true, turns: kept };
}

export function parseChatRequest(body: unknown): ParsedChatRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const rawQuestion = typeof b.question === "string" ? b.question.trim() : "";
  if (!sessionId || !rawQuestion) return { ok: false, error: "sessionId and question are required" };
  const question = rawQuestion.length > MAX_QUESTION_CHARS ? rawQuestion.slice(0, MAX_QUESTION_CHARS) : rawQuestion;

  const lastPlanningMode = typeof b.lastPlanningMode === "string" && KNOWN_MODES.has(b.lastPlanningMode) ? b.lastPlanningMode : undefined;

  if (b.history === undefined) return { ok: true, value: { sessionId, question, lastPlanningMode } };
  const history = sanitizeHistory(b.history);
  if (!history.ok) return { ok: false, error: history.error };
  return { ok: true, value: { sessionId, question, history: history.turns, lastPlanningMode } };
}

/** Builds the session for this request from the client-supplied history. Pure: touches no shared state. */
export function sessionFromRequest(request: ChatRequest): Session {
  const session = createSession();
  session.turns = [...(request.history ?? [])];
  session.lastPlanningMode = request.lastPlanningMode;
  return session;
}
