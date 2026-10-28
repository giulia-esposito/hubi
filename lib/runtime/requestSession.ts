import { createHash } from "node:crypto";
import { getRegionVocabulary } from "../applicability/regions.ts";
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
const MAX_PINNED_ENTRIES = 5;

/**
 * What was left out of the history the client sent. Surfaced to the user (a
 * notice under the answer) and to telemetry, so a context loss is never silent.
 */
export interface HistoryReport {
  /** Non-empty turns the client sent. */
  received: number;
  /** Turns actually used. */
  kept: number;
  /** Oldest turns dropped to fit the turn-count and size caps. */
  droppedOldest: number;
  /** Turns clipped to the per-turn character cap. */
  truncatedTurns: number;
}

/**
 * Conversation facts that must survive the history window: the region and
 * country in force after the previous turn. The server returns them with every
 * answer and the client sends them back, so a region stated early is not lost
 * when its message falls out of the window. A region stated in a later message
 * still wins over the pinned one. Values are validated against the approved
 * vocabulary; a forged value is no more powerful than typing it.
 */
export interface PinnedContext {
  regions: string[];
  countries: string[];
}

export interface ChatRequest {
  sessionId: string;
  question: string;
  /** Prior turns, oldest first. `undefined` means the client did not send history (fall back to server memory). */
  history?: Turn[];
  /** planningMode the previous assistant turn reported, so a short follow-up can continue an artifact request. */
  lastPlanningMode?: string;
  /** Region and country in force after the previous turn (validated). */
  pinned?: PinnedContext;
  /** What the history caps dropped; present whenever history was sent. */
  historyReport?: HistoryReport;
}

export type ParsedChatRequest = { ok: true; value: ChatRequest } | { ok: false; error: string };

const KNOWN_MODES = new Set<string>(PLANNING_MODES);

/** Validates the history sent by the client; keeps the most recent turns within the caps. */
export function sanitizeHistory(raw: unknown): { ok: true; turns: Turn[]; report: HistoryReport } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "history must be an array" };
  const turns: Turn[] = [];
  let truncatedTurns = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false, error: "history entries must be objects" };
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return { ok: false, error: "history roles must be user or assistant" };
    if (typeof content !== "string") return { ok: false, error: "history content must be a string" };
    const text = content.trim();
    if (!text) continue; // an empty turn (for example a failed answer) carries no context
    if (text.length > MAX_TURN_CHARS) truncatedTurns++;
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
  return { ok: true, turns: kept, report: { received: turns.length, kept: kept.length, droppedOldest: turns.length - kept.length, truncatedTurns } };
}

export function parseChatRequest(body: unknown): ParsedChatRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const rawQuestion = typeof b.question === "string" ? b.question.trim() : "";
  if (!sessionId || !rawQuestion) return { ok: false, error: "sessionId and question are required" };
  const question = rawQuestion.length > MAX_QUESTION_CHARS ? rawQuestion.slice(0, MAX_QUESTION_CHARS) : rawQuestion;

  const lastPlanningMode = typeof b.lastPlanningMode === "string" && KNOWN_MODES.has(b.lastPlanningMode) ? b.lastPlanningMode : undefined;

  const pinned = sanitizePinned(b.pinned);

  if (b.history === undefined) return { ok: true, value: { sessionId, question, lastPlanningMode, pinned } };
  const history = sanitizeHistory(b.history);
  if (!history.ok) return { ok: false, error: history.error };
  return { ok: true, value: { sessionId, question, history: history.turns, lastPlanningMode, pinned, historyReport: history.report } };
}

/** Keeps only regions and countries that exist in the approved vocabulary, at most a few of each. */
export function sanitizePinned(raw: unknown): PinnedContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const vocabulary = getRegionVocabulary();
  const regionNames = new Set(vocabulary.regions.map((r) => r.name));
  const countryNames = new Set(vocabulary.countries.map((c) => c.name));
  const pick = (value: unknown, allowed: Set<string>) =>
    Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && allowed.has(v)))].slice(0, MAX_PINNED_ENTRIES) : [];
  const regions = pick((raw as Record<string, unknown>).regions, regionNames);
  const countries = pick((raw as Record<string, unknown>).countries, countryNames);
  return regions.length > 0 || countries.length > 0 ? { regions, countries } : undefined;
}

export interface HistoryLog {
  /** Turns of history the model was given. */
  turns: number;
  chars: number;
  /** SHA-256 (first 16 hex chars) of the exact history used: tells whether two reports saw the same context. */
  digest: string;
  /** The last two turns, trimmed, so a reviewer can see what the model was most likely reacting to. */
  lastTurns: Turn[];
  droppedOldest: number;
  truncatedTurns: number;
}

const LOGGED_TURN_CHARS = 1_500;

/**
 * Telemetry description of the history a turn actually used. The client
 * supplies the history, so the server records what it received: a digest of
 * the exact turns plus the last two, without logging the whole conversation
 * again on every turn.
 */
export function describeHistory(turns: Turn[], report?: HistoryReport): HistoryLog {
  const digest = createHash("sha256").update(JSON.stringify(turns)).digest("hex").slice(0, 16);
  return {
    turns: turns.length,
    chars: turns.reduce((n, t) => n + t.content.length, 0),
    digest,
    lastTurns: turns.slice(-2).map((t) => ({ role: t.role, content: t.content.length > LOGGED_TURN_CHARS ? t.content.slice(0, LOGGED_TURN_CHARS) + "...[truncated]" : t.content })),
    droppedOldest: report?.droppedOldest ?? 0,
    truncatedTurns: report?.truncatedTurns ?? 0,
  };
}

/** Builds the session for this request from the client-supplied history. Pure: touches no shared state. */
export function sessionFromRequest(request: ChatRequest): Session {
  const session = createSession();
  session.turns = [...(request.history ?? [])];
  session.lastPlanningMode = request.lastPlanningMode;
  return session;
}
