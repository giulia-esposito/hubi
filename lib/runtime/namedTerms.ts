/**
 * Finds wording in the user's question that the retrieved knowledge never uses.
 *
 * Why: a tester asked about "extra check-ins", which no source mentions. Retrieval matched the word "check-ins" and
 * returned "International Check-ins", a different add-on, and the model answered about it as if it were the same
 * thing. A rule in the system prompt was followed in only about half of the runs, so the prompt also gets a concrete
 * notice naming the phrases that are missing, in the same way the applicability notices work.
 *
 * It is deliberately lexical and conservative: it only lists short phrases (two or three words) whose last word does
 * appear in the sources, which is the signature of a "similar but different" item. Ordinary wording can also be listed;
 * the notice tells the model to ignore a phrase that is not a name.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were", "be", "been", "do", "does", "did",
  "how", "what", "which", "who", "when", "where", "why", "can", "could", "should", "would", "will", "i", "we", "you", "they", "it", "my", "our", "your",
  "me", "us", "this", "that", "these", "those", "there", "about", "from", "at", "by", "as", "if", "so", "than", "then", "also", "any", "some",
  "need", "needs", "want", "please", "tell", "explain", "give", "show", "help", "get", "have", "has", "make",
]);

/** Lowercase, hyphens and punctuation to single spaces, so "Check-ins" and "check ins" compare equal. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, " ").trim();
}

/** Words of the question with internal hyphens and apostrophes kept ("check-ins" stays one word). */
function questionWords(question: string): string[] {
  return question.match(/[A-Za-z0-9À-ɏ]+(?:[-'’][A-Za-z0-9À-ɏ]+)*/g) ?? [];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0 && count < 50) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Up to `max` two- or three-word phrases from the question that appear in none of the source texts although their
 * last word does, most frequent last word first. Empty when every phrase of the question is covered.
 */
export function unmatchedPhrases(question: string, sourceTexts: string[], max = 2): string[] {
  if (sourceTexts.length === 0) return [];
  const haystack = ` ${normalize(sourceTexts.join(" | "))} `;
  const words = questionWords(question);

  // Runs of consecutive content words: a phrase never spans a stopword.
  const runs: string[][] = [];
  let run: string[] = [];
  for (const w of words) {
    if (STOPWORDS.has(w.toLowerCase()) || w.length < 3) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(w);
  }
  if (run.length) runs.push(run);

  const found: { phrase: string; headFreq: number; length: number }[] = [];
  for (const r of runs) {
    for (let size = 2; size <= 3; size++) {
      for (let start = 0; start + size <= r.length; start++) {
        const window = r.slice(start, start + size);
        const normalized = normalize(window.join(" "));
        if (haystack.includes(` ${normalized} `)) continue;
        const head = normalize(window[window.length - 1]);
        const headFreq = countOccurrences(haystack, ` ${head} `);
        if (headFreq === 0) continue;
        found.push({ phrase: window.join(" "), headFreq, length: size });
      }
    }
  }

  // A longer phrase that ends in an already listed shorter one adds nothing: keep the shortest.
  const kept = found.filter((f) => !found.some((g) => g !== f && g.length < f.length && f.phrase.toLowerCase().endsWith(g.phrase.toLowerCase())));
  kept.sort((a, b) => b.headFreq - a.headFreq || a.length - b.length);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of kept) {
    const key = f.phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f.phrase);
    if (out.length >= max) break;
  }
  return out;
}

export function namedItemNotice(phrases: string[]): string {
  const list = phrases.map((p) => `"${p}"`).join(", ");
  return (
    `[Named-item notice] These phrases from the user's question do not appear word for word in the retrieved knowledge above: ${list}. This is only a flag. ` +
    `If the user is naming a specific product, SKU, add-on or plan and the sources describe only a differently named one, say plainly that the approved knowledge does not cover the item they named. ` +
    `Do not treat the similarly named item as the same thing, never say the user's term "refers to" or "appears to be" another item, and do not write guidance for the other item in its place; you may ask once whether they meant it, naming it as a separate offer. ` +
    `If the sources do cover what the user is asking about under other wording, or the phrase is ordinary wording and not a name, ignore this notice and answer normally, including any clarifying question the other rules call for.`
  );
}
