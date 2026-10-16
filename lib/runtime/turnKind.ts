import { PLANNING_MODE_KEYWORDS, PLANNING_MODE_TAG_PREFIX, type PlanningMode } from "./planningMode.ts";

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
// answer instead of merely describing it afterwards.
const MODE_TAG_PATTERN = /^\s*\[\[HUBI:MODE:([A-Z_]*)\]\]\s*/;

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
 */
export function extractResponseTags(rawText: string): ResponseTags {
  let text = rawText;
  let planningMode: PlanningMode = "unknown";

  const modeMatch = text.match(MODE_TAG_PATTERN);
  if (modeMatch) {
    planningMode = PLANNING_MODE_KEYWORDS[modeMatch[1]] ?? "unknown";
    text = text.slice(modeMatch[0].length);
  }

  let turnKind: TurnKind = "unknown";
  const tagMatch = text.match(TAG_PATTERN);
  if (tagMatch) {
    turnKind = KNOWN_KEYWORDS[tagMatch[1]] ?? "unknown";
    text = text.slice(0, tagMatch.index);
  }

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

// A leading mode tag is abandoned (treated as ordinary text) if no closing
// "]]" shows up within this many characters.
const MAX_MODE_TAG_CHARS = 80;

/**
 * Wraps a live onDelta callback so neither tag is ever forwarded to the
 * browser, even mid-stream.
 *
 * Head phase: the start of the stream is held until it is clear whether it
 * is a leading mode tag; the tag is dropped and everything after it flows
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

  function resolveHead(): void {
    const trimmed = buffer.trimStart();
    if (!trimmed) return;

    const couldBeTag = PLANNING_MODE_TAG_PREFIX.startsWith(trimmed) || trimmed.startsWith(PLANNING_MODE_TAG_PREFIX);
    if (!couldBeTag) {
      const held = buffer;
      buffer = "";
      phase = "body";
      pushBody(held);
      return;
    }

    const close = trimmed.indexOf("]]");
    if (close === -1) {
      if (trimmed.length > MAX_MODE_TAG_CHARS) {
        const held = buffer;
        buffer = "";
        phase = "body";
        pushBody(held);
      }
      return;
    }

    const rest = trimmed.slice(close + 2);
    buffer = "";
    phase = "body";
    dropLeadingWhitespace = true;
    pushBody(rest);
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
      const { text } = extractResponseTags(buffer);
      if (text) onVisibleDelta(text);
      buffer = "";
    },
  };
}
