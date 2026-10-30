export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface Session {
  turns: Turn[];
  /** planningMode reported on the previous assistant turn; lets a short follow-up continue an artifact request. */
  lastPlanningMode?: string;
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
  return searchContext(session.turns.filter((t) => t.role === "user").map((t) => t.content)).query;
}

export interface SearchContext {
  /** What retrieval searches: the question that opened the current topic plus every message after it. */
  query: string;
  /** The message that opened the current topic: what the cross-language check should read, never a one-word reply to a clarifying question. */
  anchor: string;
  /** True when an earlier topic was left behind. */
  reset: boolean;
  /** Index, among the user messages, of the message that opened the topic. */
  start: number;
}

/** Words that open a request ("write me a pitch"), so a short message that starts with one is a new request and not a reply. */
const REQUEST_OPENERS = new Set(
  "what how why when where who which can could should would do does is are write draft create make build give show tell explain list prepare help find summarize compare qual quais como quando onde quem por que qué cuál cuáles cómo cuándo dónde escreva escreve escribe haz hazme dame crea".split(" ")
);
const TERM_STOP = new Set(
  "de do da dos das del la el los las le um uma un una em en no na nos nas por para com con se que qué como cómo qual quais the and for with are was were what how why when where who which can could should would does did have has this that from your you our not about".split(" ")
);

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const contentTerms = (text: string) => new Set(wordsOf(text).filter((w) => w.length > 2 && !TERM_STOP.has(w)));

/** A message that asks or requests something, as opposed to a reply that supplies context ("Mexico", "Tier 1", "A company from the financial industry"). Statements never start a new topic. */
function opensARequest(message: string): boolean {
  if (/[?¿]/.test(message)) return true;
  return REQUEST_OPENERS.has(wordsOf(message)[0] ?? "");
}

/**
 * The search context for the latest turn. A short reply that gives context ("Mexico") continues the question it answers, so the
 * question's own words (and language) stay in the search: found in production, where a one-word reply made retrieval lose
 * the onboarding steps and the cross-language terms. A new question that shares no content word with the current topic starts
 * a new topic, so an earlier question cannot pull the search toward its subject. A follow-up that shares a word with the topic
 * ("what about Tier 3?" after an onboarding question) stays in it. Deterministic; the region the user stated is tracked
 * separately and is not affected by a topic change.
 */
export function searchContext(userMessages: string[]): SearchContext {
  let start = 0;
  for (let i = 1; i < userMessages.length; i++) {
    if (!opensARequest(userMessages[i])) continue;
    const topic = contentTerms(userMessages.slice(start, i).join(" "));
    const own = contentTerms(userMessages[i]);
    if (![...own].some((w) => topic.has(w))) start = i;
  }
  const kept = userMessages.slice(start);
  return { query: kept.join(" "), anchor: kept[0] ?? "", reset: start > 0, start };
}

/** An assistant turn that is a short question: the heuristic the evals use, applied to the history. */
const isClarifyingTurn = (content: string) => /[?¿]["')\]*_]*$/.test(content.trim()) && content.trim().length < 400;

/** How many clarifying questions Hubi has already asked in the current topic (turns before the latest user message). */
export function clarificationsInTopic(turns: Turn[]): number {
  const users = turns.filter((t) => t.role === "user").map((t) => t.content);
  const { start } = searchContext(users);
  let seen = -1;
  let count = 0;
  for (const t of turns) {
    if (t.role === "user") {
      seen++;
      continue;
    }
    if (seen >= start && isClarifyingTurn(t.content)) count++;
  }
  return count;
}
