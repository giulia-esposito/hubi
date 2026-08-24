import { createSession, type Session } from "./sessionState.ts";

/**
 * Server-side conversation state, keyed by a browser-generated sessionId.
 * In-memory only, no eviction -- correct scope for "continuity within the
 * current browser session" on a short-lived local prototype test; a stale
 * entry is harmless and simply garbage once its browser session ends.
 */
const sessions = new Map<string, Session>();

export function getOrCreateSession(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = createSession();
    sessions.set(sessionId, session);
  }
  return session;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}
