import { detectLanguage, type QueryLanguage } from "../retrieval/queryExpansion.ts";

/**
 * Product decision (2026-11-04), refining "language is not applicability": when the question is written in one of
 * the languages below, the user's region is taken from it, so Hubi does not ask "which region?" for a question
 * that already says. Spanish and English are not on the list on purpose: each is used in several operating regions
 * (Spain and SS Latam; the US, the UK and Brazil), so there the region is asked for, never assumed.
 *
 *   Portuguese -> Brazil   (Portugal is part of Europe in the approved map: a Portuguese question from there
 *                           is corrected the moment the user names the country)
 *   German, French, Italian, Dutch -> Europe
 *
 * The inferred region is the weakest signal: a region the user names, or one carried from earlier in the
 * conversation, always wins, and an inferred region is never pinned for later turns.
 */
export const LANGUAGE_REGION: Partial<Record<QueryLanguage, string>> = {
  pt: "Brazil",
  de: "Europe",
  fr: "Europe",
  it: "Europe",
  nl: "Europe",
};

export function languageRegionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HUBI_LANGUAGE_REGION?.trim() !== "0";
}

const wordCount = (text: string) => (text.match(/[\p{L}]+/gu) ?? []).length;

/**
 * The region implied by the language of the user's most recent message that has enough words to judge (a one-word
 * reply such as "Tier 1" says nothing about language, so the message before it decides). Undefined when that
 * language is not on the list, or cannot be told.
 */
export function inferRegionFromLanguage(userMessages: string[]): string | undefined {
  for (let i = userMessages.length - 1; i >= 0; i--) {
    if (wordCount(userMessages[i]) < 3) continue;
    return LANGUAGE_REGION[detectLanguage(userMessages[i])];
  }
  return undefined;
}
