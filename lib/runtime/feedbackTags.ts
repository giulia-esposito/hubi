/**
 * Lightweight issue tags for tester feedback during the pilot. Plain data, no
 * Node dependencies, so the browser UI and the feedback route share one list.
 * The tags map to what the pilot needs to learn: where the answer was wrong
 * (region, claim, source), lost conversation context (a tripwire for moving to
 * server-side sessions, docs/session-architecture.md), the known open gap (scope or causality
 * strengthening, Finding #005), and how the wait felt (buffered delivery).
 */
export const FEEDBACK_TAGS = [
  "wrong-region",
  "unsupported-claim",
  "scope-or-causality",
  "wrong-or-missing-source",
  "lost-context",
  "too-slow",
  "other",
] as const;

export type FeedbackTag = (typeof FEEDBACK_TAGS)[number];

export const FEEDBACK_TAG_LABELS: Record<FeedbackTag, string> = {
  "wrong-region": "Wrong region",
  "unsupported-claim": "Claim not in the sources",
  "scope-or-causality": "Claim overstated (scope or cause)",
  "wrong-or-missing-source": "Wrong or missing source",
  "lost-context": "It forgot what we discussed",
  "too-slow": "Too slow / waiting felt long",
  other: "Other",
};

const ALLOWED = new Set<string>(FEEDBACK_TAGS);

/** Keeps only known tags, once each, at most one of each. */
export function sanitizeFeedbackTags(raw: unknown): FeedbackTag[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedbackTag[] = [];
  for (const item of raw) {
    if (typeof item === "string" && ALLOWED.has(item) && !out.includes(item as FeedbackTag)) out.push(item as FeedbackTag);
  }
  return out;
}
