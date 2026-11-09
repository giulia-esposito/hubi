import type { Chunk } from "../ingestion/chunk.ts";

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

interface IndexedChunk {
  chunk: Chunk;
  termFreq: Map<string, number>;
  length: number;
}

export interface RetrievalIndex {
  indexed: IndexedChunk[];
  docFreq: Map<string, number>;
  avgLength: number;
  n: number;
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were",
  "be", "been", "being", "this", "that", "these", "those", "it", "its", "as", "at", "by", "from", "into",
  "about", "if", "then", "than", "so", "such", "not", "no", "do", "does", "did", "can", "could", "should",
  "would", "will", "shall", "may", "might", "must", "have", "has", "had", "you", "your", "i", "we", "our",
  "they", "their", "he", "she", "his", "her", "them", "what", "which", "who", "whom", "when", "where", "how",
  "why", "there", "here", "up", "down", "out", "over", "under", "again", "further", "own", "same", "just",
  "also", "some", "any", "all", "each", "other", "only", "more", "most", "very", "one", "two",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Builds an in-memory BM25 index over chunks. No embeddings, no vector store --
 * per Prototype_Plan.md Section 5, retrieval is lexical + metadata only.
 * Heading text is folded into the indexed tokens twice to give heading matches
 * a cheap relevance boost, without a separate scoring path.
 */
export function buildIndex(chunks: Chunk[]): RetrievalIndex {
  const indexed: IndexedChunk[] = [];
  const docFreq = new Map<string, number>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const headingBoostText = chunk.heading ? `${chunk.heading} ${chunk.heading}` : "";
    const tokens = tokenize(`${headingBoostText} ${chunk.text}`);
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    for (const t of termFreq.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    indexed.push({ chunk, termFreq, length: tokens.length });
    totalLength += tokens.length;
  }

  return { indexed, docFreq, avgLength: totalLength / Math.max(indexed.length, 1), n: indexed.length };
}

const K1 = 1.5;
const B = 0.75;

/** Weight of another form of a question word ("duplicate" for "duplicated") next to the word itself. */
const WORD_FORM_WEIGHT = 0.8;

/** A question word found in at most this many chunks is specific enough for its other forms to be searched too. */
const RARE_WORD_DOCS = 10;

/**
 * The base and sibling forms of an inflected English word (-ed, -ing, -es, -s), never longer forms of a bare word, so a question that says "duplicated rules" reaches passages that say "duplicate" (found in
 * the pilot, 2026-11-09: the playbook explains duplicates, the question used another form, and Hubi answered that the knowledge
 * had nothing). Applied to the question only and matched against the index as it is, so Spanish and Portuguese documents are
 * untouched. Used only for rare words.
 */
export function wordForms(term: string): string[] {
  const t = term;
  const out: string[] = [];
  if (t.length >= 7 && t.endsWith("ing")) {
    const base = t.slice(0, -3);
    out.push(base, base + "e", base + "ed", base + "es");
  } else if (t.length >= 6 && t.endsWith("ed")) {
    const base = t.slice(0, -2);
    out.push(base, base + "e", base + "es", base + "ing");
  } else if (t.length >= 5 && t.endsWith("es")) {
    out.push(t.slice(0, -2), t.slice(0, -1));
  } else if (t.length >= 5 && t.endsWith("s") && !t.endsWith("ss")) {
    out.push(t.slice(0, -1));
  }
  return out;
}

export function search(index: RetrievalIndex, query: string, topK = 5): ScoredChunk[] {
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];
  const weights = new Map<string, number>(queryTerms.map((t) => [t, 1]));
  // Only for a rare word (the specific one in a question, such as "duplicated"): common words already find their passages, and adding forms to them moved the ranking of questions that work.
  for (const t of queryTerms) if ((index.docFreq.get(t) ?? 0) <= RARE_WORD_DOCS) for (const form of wordForms(t)) if (!weights.has(form) && index.docFreq.has(form)) weights.set(form, WORD_FORM_WEIGHT);

  const scored: ScoredChunk[] = index.indexed.map(({ chunk, termFreq, length }) => {
    let score = 0;
    for (const [term, weight] of weights) {
      const df = index.docFreq.get(term);
      if (!df) continue;
      const tf = termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const idf = Math.log((index.n - df + 0.5) / (df + 0.5) + 1);
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * (1 - B + (B * length) / index.avgLength);
      score += weight * idf * (numerator / denominator);
    }
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
