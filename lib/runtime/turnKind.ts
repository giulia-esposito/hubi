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

/**
 * Strips Hubi's trailing self-report tag (see lib/runtime/promptBuilder.ts)
 * from the model's final text and returns the classification it implies.
 * This is a model self-report, not independent classification -- intentional
 * accepted prototype debt (see Prototype_Plan.md). A missing or malformed
 * tag never breaks the response: the full text is preserved either way.
 */
export function extractTurnKind(rawText: string): { text: string; turnKind: TurnKind } {
  const match = rawText.match(TAG_PATTERN);
  if (!match) return { text: rawText.trim(), turnKind: "unknown" };
  const text = rawText.slice(0, match.index).trim();
  const turnKind = KNOWN_KEYWORDS[match[1]] ?? "unknown";
  return { text, turnKind };
}

// Longer than the longest real tag string ("\n[[HUBI:CLARIFYING_QUESTION]]"
// is ~30 chars) with generous margin for a typo'd keyword.
const HOLDBACK_CHARS = 60;

/**
 * Wraps a live onDelta callback so the trailing tag is never forwarded to
 * the browser, even mid-stream. Holds back the last HOLDBACK_CHARS of text
 * (imperceptible lag, not a per-character tag-prefix parser) and only
 * flushes it once finish() confirms it wasn't actually a tag. The
 * authoritative turnKind for logging/session storage should still come from
 * extractTurnKind() on the full final text, not from this streamer -- this
 * exists purely to keep the tag off the screen during live streaming.
 */
export function createTagAwareStreamer(onVisibleDelta: (text: string) => void) {
  let buffer = "";
  return {
    push(delta: string): void {
      buffer += delta;
      if (buffer.length > HOLDBACK_CHARS) {
        const flushLength = buffer.length - HOLDBACK_CHARS;
        onVisibleDelta(buffer.slice(0, flushLength));
        buffer = buffer.slice(flushLength);
      }
    },
    finish(): void {
      const { text } = extractTurnKind(buffer);
      if (text) onVisibleDelta(text);
      buffer = "";
    },
  };
}
