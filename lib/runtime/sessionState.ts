export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface Session {
  turns: Turn[];
}

/**
 * In-memory conversation state for the active local session only, per
 * Architecture.md Section 12 ("initial implementation may maintain
 * conversation state only during the active local session"). No persistence,
 * no cross-session memory -- a new process starts a new Session.
 */
export function createSession(): Session {
  return { turns: [] };
}

export function addTurn(session: Session, role: Turn["role"], content: string): void {
  session.turns.push({ role, content });
}

/**
 * The retrieval query for any given turn is every user message so far, not
 * just the latest one. This is a deliberately simple way to keep retrieval
 * relevant across a clarifying-question exchange (e.g. turn 1 "what discount
 * can I offer" + turn 2 "it's Brazil, ENT segment" still retrieves discount-
 * policy content on turn 2, even though turn 2 alone has no "discount" token)
 * without building a separate intent/context classifier.
 */
export function accumulatedUserQuery(session: Session): string {
  return session.turns
    .filter((t) => t.role === "user")
    .map((t) => t.content)
    .join(" ");
}
