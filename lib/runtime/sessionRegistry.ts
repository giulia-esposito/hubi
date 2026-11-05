import { createSession, type Session } from "./sessionState.ts";

/**
 * Server-side conversation state, keyed by a browser-generated sessionId. It is only a fallback for older clients:
 * current clients send their prior turns with every request and the session is rebuilt from them
 * (lib/runtime/requestSession.ts), so continuity never depends on which instance answers.
 *
 * In memory, and bounded: a session unused for SESSION_TTL_MS is dropped, and when more than MAX_SESSIONS are live the
 * least recently used goes first. Without a bound, every distinct sessionId a caller invents would stay in memory for
 * the life of the process.
 */
export const MAX_SESSIONS = 500;
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

interface Entry {
  session: Session;
  lastUsed: number;
}

export class SessionRegistry {
  private entries = new Map<string, Entry>(); // insertion order is least recently used first

  private max: number;
  private ttlMs: number;
  private now: () => number;

  constructor(max = MAX_SESSIONS, ttlMs = SESSION_TTL_MS, now: () => number = Date.now) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  getOrCreate(sessionId: string): Session {
    const t = this.now();
    this.sweep(t);
    let entry = this.entries.get(sessionId);
    if (entry) this.entries.delete(sessionId); // re-inserted below, as most recently used
    else entry = { session: createSession(), lastUsed: t };
    entry.lastUsed = t;
    this.entries.set(sessionId, entry);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return entry.session;
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(t: number): void {
    for (const [id, e] of this.entries) {
      if (t - e.lastUsed <= this.ttlMs) break; // ordered by recency: the rest are newer
      this.entries.delete(id);
    }
  }
}

const registry = new SessionRegistry();

export function getOrCreateSession(sessionId: string): Session {
  return registry.getOrCreate(sessionId);
}

export function deleteSession(sessionId: string): void {
  registry.delete(sessionId);
}
