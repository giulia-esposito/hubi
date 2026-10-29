/**
 * Temporary conversation history kept in the user's own browser, so a page
 * reload or a closed tab does not lose context (the server already holds
 * nothing: every request carries the conversation, see requestSession.ts, so a
 * restart or a redeploy never loses it either).
 *
 * Rules, all deliberate:
 *   - one conversation at a time, one entry in browser storage;
 *   - it expires after `ttlMs` of inactivity: every save pushes the expiry out,
 *     an expired entry is deleted on the next load, and the user sees a fresh
 *     conversation;
 *   - the only other way to lose it is the explicit "New conversation" action
 *     (clearConversation);
 *   - nothing leaves the browser from here; this module never touches the network;
 *   - storage can fail (private mode, a full quota, blocked site data): every
 *     call degrades to "no stored conversation" and never throws.
 *
 * Pure with the store and the clock injected, so it is tested without a browser.
 */

export const CONVERSATION_KEY = "hubi-conversation-v1";

/** Inactivity window after which a stored conversation is dropped. */
export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Older turns beyond this are dropped from the stored copy, matching what the page ever sends. */
export const MAX_STORED_MESSAGES = 48;

/** A stored copy larger than this (characters of JSON) is trimmed from the oldest end. */
const MAX_STORED_CHARS = 1_500_000;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The fields of a chat message the store needs to know about; everything else is carried through untouched. */
export interface StorableMessage {
  role: "user" | "assistant";
  text: string;
  isStreaming?: boolean;
  error?: string;
}

interface StoredConversation<M> {
  version: 1;
  id: string;
  updatedAt: number;
  messages: M[];
}

export interface LoadedConversation<M> {
  id: string;
  messages: M[];
  updatedAt: number;
}

/** Fields that only make sense in the page that produced them, never worth keeping. */
const TRANSIENT_KEYS = ["isStreaming", "showCommentBox", "sentAt"] as const;

function stripTransient<M extends StorableMessage>(message: M): M {
  const copy = { ...message } as unknown as Record<string, unknown>;
  for (const key of TRANSIENT_KEYS) delete copy[key];
  return copy as unknown as M;
}

/**
 * What is worth keeping: finished messages only. A conversation reloaded in the
 * middle of an answer would otherwise come back with a half-written reply, so a
 * trailing incomplete assistant message is dropped together with the question
 * that produced it (the user can ask again).
 */
export function messagesToStore<M extends StorableMessage>(messages: M[]): M[] {
  let end = messages.length;
  const last = messages[end - 1];
  if (last && last.role === "assistant" && (last.isStreaming || (!last.text.trim() && !last.error))) {
    end -= 1;
    if (end > 0 && messages[end - 1].role === "user") end -= 1;
  }
  return messages.slice(0, end).map(stripTransient).slice(-MAX_STORED_MESSAGES);
}

export function saveConversation<M extends StorableMessage>(store: KeyValueStore, id: string, messages: M[], now: number): void {
  try {
    let kept = messagesToStore(messages);
    if (kept.length === 0) {
      store.removeItem(CONVERSATION_KEY);
      return;
    }
    let payload = JSON.stringify({ version: 1, id, updatedAt: now, messages: kept } satisfies StoredConversation<M>);
    while (payload.length > MAX_STORED_CHARS && kept.length > 2) {
      kept = kept.slice(2);
      payload = JSON.stringify({ version: 1, id, updatedAt: now, messages: kept } satisfies StoredConversation<M>);
    }
    store.setItem(CONVERSATION_KEY, payload);
  } catch {
    // Storage is best effort: a full or blocked store must not break the conversation.
  }
}

/** The stored conversation, or null when there is none, it expired, or it is unreadable (the entry is then deleted). */
export function loadConversation<M extends StorableMessage>(store: KeyValueStore, now: number, ttlMs: number = CONVERSATION_TTL_MS): LoadedConversation<M> | null {
  try {
    const raw = store.getItem(CONVERSATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredConversation<M>>;
    const valid =
      parsed &&
      parsed.version === 1 &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0 &&
      typeof parsed.updatedAt === "number" &&
      Array.isArray(parsed.messages) &&
      parsed.messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string");
    if (!valid || now - (parsed.updatedAt as number) >= ttlMs || (parsed.updatedAt as number) > now + 60_000) {
      store.removeItem(CONVERSATION_KEY);
      return null;
    }
    return { id: parsed.id as string, messages: parsed.messages as M[], updatedAt: parsed.updatedAt as number };
  } catch {
    try {
      store.removeItem(CONVERSATION_KEY);
    } catch {
      // nothing more to do
    }
    return null;
  }
}

/** The explicit "New conversation": the only deliberate way to lose context before the TTL. */
export function clearConversation(store: KeyValueStore): void {
  try {
    store.removeItem(CONVERSATION_KEY);
  } catch {
    // nothing to clear
  }
}
