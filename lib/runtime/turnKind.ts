import { PLANNING_MODE_KEYWORDS, type PlanningMode } from "./planningMode.ts";
import { stripClaimsBlock } from "./claimAttribution.ts";

export type TurnKind = "grounded-answer" | "clarifying-question" | "no-grounded-answer" | "unknown";

const KNOWN_KEYWORDS: Record<string, TurnKind> = {
  GROUNDED_ANSWER: "grounded-answer",
  CLARIFYING_QUESTION: "clarifying-question",
  NO_GROUNDED_ANSWER: "no-grounded-answer",
};

// Matches any well-shaped trailing tag, not just the three known keywords --
// so a model typo (e.g. GROUNDED_ANSWEER) still gets stripped from the
// visible text instead of leaking a malformed tag into the UI. Only an
// exact keyword match maps to a specific TurnKind; anything else (including
// no tag at all) is "unknown", which the UI must render with neutral styling.
const TAG_PATTERN = /\n?\[\[HUBI:([A-Z_]*)\]\]\s*$/;

// The planning-mode tag is LEADING (line 1), not trailing: the model commits
// to the job-to-be-done before writing, so the classification steers the
// answer instead of merely describing it afterwards. The canonical form is
// [[HUBI:MODE:<KEYWORD>]], but live Gemini runs sometimes drop "MODE:"
// ([[HUBI:BUSINESS_ASSISTANCE]]) or put a turn-kind tag on line 1. Any
// leading [[HUBI:...]] tag is therefore stripped from the visible text, and
// interpreted by keyword: the "MODE:" prefix is optional.
const LEADING_TAG_PATTERN = /^\s*\[\[HUBI:(?:MODE:)?([A-Z_]*)\]\]\s*/;
const LEADING_TAG_PREFIX = "[[HUBI:";

export interface ResponseTags {
  text: string;
  turnKind: TurnKind;
  planningMode: PlanningMode;
}

/**
 * Strips Hubi's self-report tags (see lib/runtime/promptBuilder.ts) from the
 * model's final text: a leading planning-mode tag and a trailing turn-kind
 * tag. These are model self-reports, not independent classification --
 * intentional accepted prototype debt (see Prototype_Plan.md). A missing or
 * malformed tag never breaks the response: the full text is preserved either
 * way and the corresponding field is "unknown".
 *
 * If the leading tag is a turn-kind keyword instead of a mode keyword (a
 * model mix-up), it is still stripped; it supplies the turn kind only when no
 * trailing tag does, and the planning mode stays "unknown".
 */
export function extractResponseTags(rawText: string): ResponseTags {
  // The hidden claims ledger (lib/runtime/claimAttribution.ts) is never part of the visible text.
  let text = stripClaimsBlock(rawText);
  let planningMode: PlanningMode = "unknown";
  let leadingTurnKind: TurnKind = "unknown";

  const leading = text.match(LEADING_TAG_PATTERN);
  if (leading) {
    planningMode = PLANNING_MODE_KEYWORDS[leading[1]] ?? "unknown";
    leadingTurnKind = KNOWN_KEYWORDS[leading[1]] ?? "unknown";
    text = text.slice(leading[0].length);
  }

  let turnKind: TurnKind = "unknown";
  const trailing = text.match(TAG_PATTERN);
  if (trailing) {
    turnKind = KNOWN_KEYWORDS[trailing[1]] ?? "unknown";
    text = text.slice(0, trailing.index);
  }
  if (turnKind === "unknown") turnKind = leadingTurnKind;

  return { text: text.trim(), turnKind, planningMode };
}

/** Turn-kind-only view of extractResponseTags, kept for existing callers. */
export function extractTurnKind(rawText: string): { text: string; turnKind: TurnKind } {
  const { text, turnKind } = extractResponseTags(rawText);
  return { text, turnKind };
}

// Longer than the longest trailing tag ("\n[[HUBI:CLARIFYING_QUESTION]]" is
// ~30 chars) with generous margin for a typo'd keyword.
const HOLDBACK_CHARS = 60;

// A leading tag is abandoned (treated as ordinary text) if no closing "]]"
// shows up within this many characters.
const MAX_LEADING_TAG_CHARS = 80;

/**
 * Wraps a live onDelta callback so neither tag is ever forwarded to the
 * browser, even mid-stream.
 *
 * Head phase: the start of the stream is held until it is clear whether it
 * is a leading tag; the tag is dropped and everything after it flows
 * through. Body phase: the last HOLDBACK_CHARS of text are held back
 * (imperceptible lag, not a per-character tag-prefix parser) and only
 * flushed once finish() confirms they weren't a trailing tag.
 *
 * The authoritative turnKind/planningMode for logging/session storage should
 * still come from extractResponseTags() on the full final text, not from
 * this streamer -- this exists purely to keep tags off the screen.
 */
export function createTagAwareStreamer(onVisibleDelta: (text: string) => void) {
  let buffer = "";
  let phase: "head" | "body" = "head";
  let dropLeadingWhitespace = false;

  function pushBody(chunk: string): void {
    if (dropLeadingWhitespace) {
      chunk = chunk.replace(/^\s+/, "");
      if (!chunk) return;
      dropLeadingWhitespace = false;
    }
    buffer += chunk;
    if (buffer.length > HOLDBACK_CHARS) {
      const flushLength = buffer.length - HOLDBACK_CHARS;
      onVisibleDelta(buffer.slice(0, flushLength));
      buffer = buffer.slice(flushLength);
    }
  }

  function enterBody(held: string): void {
    buffer = "";
    phase = "body";
    pushBody(held);
  }

  function resolveHead(): void {
    const trimmed = buffer.trimStart();
    if (!trimmed) return;

    const couldBeTag = LEADING_TAG_PREFIX.startsWith(trimmed) || trimmed.startsWith(LEADING_TAG_PREFIX);
    if (!couldBeTag) {
      enterBody(buffer);
      return;
    }

    const close = trimmed.indexOf("]]");
    if (close === -1) {
      if (trimmed.length > MAX_LEADING_TAG_CHARS) enterBody(buffer);
      return;
    }

    dropLeadingWhitespace = true;
    enterBody(trimmed.slice(close + 2));
  }

  return {
    push(delta: string): void {
      if (phase === "body") {
        pushBody(delta);
        return;
      }
      buffer += delta;
      resolveHead();
    },
    finish(): void {
      let rest: string;
      if (phase === "head") {
        // The whole response is still held, so it is safe to trim both ends.
        rest = extractResponseTags(buffer).text;
      } else {
        // Earlier text was already flushed, so only the trailing tag and
        // trailing whitespace may be removed here -- trimming the start would
        // drop a real space that sits at the flush boundary ("can" + " transform").
        rest = buffer.replace(TAG_PATTERN, "").trimEnd();
      }
      if (rest) onVisibleDelta(rest);
      buffer = "";
    },
  };
}
