/**
 * Scrubbing of personal identifiers from text that is logged (never from text
 * the user or the model sees).
 *
 * Hubi's users are asked not to type personal data, but free text can contain
 * anything. Before a question, an answer or a feedback comment is written to
 * the log, obvious personal identifiers are replaced with a placeholder, so a
 * stray email address or phone number does not become stored data. It is a
 * pattern filter, not a guarantee: names and free-form details are not caught,
 * which is why the UI notice and the retention period still matter.
 *
 * It only reduces what is stored. HUBI_LOG_SCRUB=0 turns it off (for example
 * when debugging locally).
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// A run of digits with common phone separators. It is replaced only when it
// holds enough digits to be a phone or identity number, so dates (8 digits),
// years, prices and short codes stay readable.
const NUMBER_RUN = /(?<![\w-])\+?\(?\d[\d\s().-]{5,}\d(?![\w-])/g;
const MIN_DIGITS = 9;
const MIN_DIGITS_WITH_PLUS = 7;

export function scrubText(text: string): string {
  return text.replace(EMAIL, "[email]").replace(NUMBER_RUN, (match) => {
    const digits = match.replace(/\D/g, "").length;
    const needed = match.startsWith("+") ? MIN_DIGITS_WITH_PLUS : MIN_DIGITS;
    return digits >= needed ? "[number]" : match;
  });
}

/** Keys whose string values are free text a person or the model wrote; everything else (ids, timestamps, urls, enums) is left exactly as is. */
export const TEXT_KEYS: ReadonlySet<string> = new Set(["question", "response", "comment", "query", "terms", "draft", "claim", "quote", "text"]);

export function scrubEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HUBI_LOG_SCRUB?.trim() !== "0";
}

/** Walks a log entry and scrubs the free-text fields. Returns a new value; the input is not modified. */
export function scrubEntry<T>(value: T, key?: string): T {
  if (typeof value === "string") return (key !== undefined && TEXT_KEYS.has(key) ? scrubText(value) : value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubEntry(v, key)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubEntry(v, k);
    return out as T;
  }
  return value;
}
