import type { RetrievalIndex, ScoredChunk } from "./index.ts";
import { search } from "./index.ts";

/**
 * Conditional multilingual query expansion.
 *
 * BM25 matches words, so a question and an answer in different languages share
 * no vocabulary (benchmark: cross-language Recall@15 of 25%; docs/retrieval-
 * benchmark.md). When that is likely, one cheap model call writes the question's
 * key terms in the other corpus language(s), the index is searched with both,
 * and the two rankings are fused. Nothing else changes: governance, the
 * Applicability Layer and the fact pass run on the fused result exactly as
 * before, and the expansion only ever supplies search words, never answer text.
 *
 * It is conditional on purpose, to keep the model call off the common path:
 *   - a Spanish or Portuguese question is expanded to English (the corpus is
 *     mostly English, and the lexical score cannot be trusted here: Spanish
 *     function words match the Spanish documents strongly while the answer sits
 *     in an English one);
 *   - an English question is expanded to Spanish and Portuguese only when its
 *     lexical match is weak.
 * A failed or empty expansion falls back to plain BM25 with no error shown.
 *
 * The language check is a small stopword and character-cue heuristic, not a
 * classifier: it decides only whether to spend a call, and a wrong guess costs
 * one call or one missed expansion, never a wrong answer.
 */

export type QueryLanguage = "en" | "es" | "pt" | "es-pt" | "unknown";

const EN_SET = new Set(
  "the and is are was were what how do does did to of for with my i in on can should when who why which have has this that these those it our your we they be an or not about from by at as if".split(" ")
);
// Words that are Spanish and not Portuguese, or the reverse, so the two do not blur.
const ES_ONLY = new Set("el los las es son qué cuál cuáles cuándo cómo dónde quién con tengo tienes hago puedo debo está están también pero muy mi mis nuestro nuestros unos unas lo y un".split(" "));
const PT_ONLY = new Set("o os as é são não qual quais quando onde quem tenho tem faço posso devo estão também mas muito meu minha meus minhas nosso nossos porque porquê uns umas pelo pela do da dos das no na nos nas e em uma um".split(" "));
// Spanish and Portuguese both: enough to say "not English", not enough to say which.
const SHARED = new Set("de del para por se su sus en que como cliente clientes reuniones".split(" "));

const words = (text: string) => text.toLowerCase().match(/[\p{L}]+/gu) ?? [];

/**
 * A rough language guess for the corpus languages. "es-pt" means clearly not English but Spanish and
 * Portuguese cannot be told apart; "unknown" means too little evidence to say anything.
 */
export function detectLanguage(text: string): QueryLanguage {
  const tokens = words(text);
  if (tokens.length === 0) return "unknown";
  let en = 0;
  let es = 0;
  let pt = 0;
  let shared = 0;
  for (const t of tokens) {
    if (EN_SET.has(t)) en++;
    if (ES_ONLY.has(t)) es++;
    if (PT_ONLY.has(t)) pt++;
    if (SHARED.has(t)) shared++;
  }
  if (/[¿¡ñ]/.test(text)) es += 3;
  if (/[ãõç]/i.test(text)) pt += 3;
  if (en > 0 && en >= es + pt + shared) return "en";
  if (es > pt) return "es";
  if (pt > es) return "pt";
  if (es + pt + shared >= 2) return "es-pt";
  return en > 0 ? "en" : "unknown";
}

/** Top BM25 score below which an English question is treated as weakly matched (relevant results scored 5-28, noise 1-3; the cut is tuned on the benchmark). */
export const WEAK_SCORE = 12;
const MIN_WORDS_FOR_WEAK_TRIGGER = 3;

export interface ExpansionPlan {
  expand: boolean;
  reason: "non-english-query" | "weak-lexical-match" | "sufficient" | "too-short";
  language: QueryLanguage;
  targets: string[];
}

export function planExpansion(question: string, topScore: number): ExpansionPlan {
  const language = detectLanguage(question);
  if (language === "es" || language === "pt" || language === "es-pt") return { expand: true, reason: "non-english-query", language, targets: ["English"] };
  if (words(question).length < MIN_WORDS_FOR_WEAK_TRIGGER) return { expand: false, reason: "too-short", language, targets: [] };
  if (topScore < WEAK_SCORE) return { expand: true, reason: "weak-lexical-match", language, targets: ["Spanish", "Portuguese"] };
  return { expand: false, reason: "sufficient", language, targets: [] };
}

export const EXPANSION_SYSTEM_PROMPT = "You write search keywords for an internal knowledge base. Output only one line of keywords: no explanation, no quotes, no punctuation other than spaces.";

export function buildExpansionPrompt(question: string, targets: string[]): string {
  return (
    `Question: ${question}\n\n` +
    `Write the key search terms of this question in ${targets.join(" and ")}, as 4 to 12 words or short phrases separated by spaces. ` +
    `Keep product names, tool names, acronyms and numbers exactly as written. Output a single line.`
  );
}

const MAX_TERMS_CHARS = 200;

/** Reduces a model reply to one safe line of search words, or "" when nothing usable came back. */
export function parseExpansionTerms(reply: string): string {
  const line =
    reply
      .replace(/\[\[HUBI:[^\]]*\]\]/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line
    .replace(/^["'`*\-\s]+|["'`*\s]+$/g, "")
    .replace(/[^\p{L}\p{N}\s%$+.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TERMS_CHARS);
}

export interface RankedList {
  results: ScoredChunk[];
  weight: number;
}

const RRF_K = 60;

/**
 * Weighted reciprocal rank fusion. A chunk's fused rank is the weighted sum of
 * 1/(k + rank) over the lists it appears in, so a chunk found by both searches
 * rises and neither list's raw scores (which are on different scales) matter.
 * The score reported with each chunk stays its best original BM25 score.
 */
export function fuseRankings(lists: RankedList[], limit: number): ScoredChunk[] {
  const fused = new Map<string, { chunk: ScoredChunk["chunk"]; rrf: number; score: number }>();
  for (const { results, weight } of lists) {
    results.forEach((r, i) => {
      const entry = fused.get(r.chunk.id) ?? { chunk: r.chunk, rrf: 0, score: 0 };
      entry.rrf += weight / (RRF_K + i + 1);
      entry.score = Math.max(entry.score, r.score);
      fused.set(r.chunk.id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map((e) => ({ chunk: e.chunk, score: e.score }));
}

/** Weights when fusing: the expansion is trusted more when the original query is in the wrong language, less when it is just weak. */
export function fusionWeights(reason: ExpansionPlan["reason"]): { original: number; expansion: number } {
  return reason === "non-english-query" ? { original: 1, expansion: 1 } : { original: 1, expansion: 0.6 };
}

export interface ExpansionInfo {
  triggered: boolean;
  reason: ExpansionPlan["reason"];
  language: QueryLanguage;
  /** The search terms the model produced (empty when none, or not triggered). */
  terms: string;
  ms: number;
  /** Why a triggered expansion produced nothing: the model call failed or returned no usable words. */
  error?: string;
}

export interface ExpansionEngine {
  (prompt: string, system: string, opts?: { timeoutMs?: number; fast?: boolean }): Promise<{ ok: boolean; text: string; error?: string }>;
}

export const EXPANSION_TIMEOUT_MS = 10_000;

/** HUBI_QUERY_EXPANSION=0 turns the expansion off (plain BM25 only). */
export function expansionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HUBI_QUERY_EXPANSION?.trim() !== "0";
}

/**
 * Decides whether to expand and, when so, makes the one model call. Never
 * throws and never blocks the answer on failure: the caller falls back to the
 * plain lexical query when `terms` is empty.
 */
export async function expandQuery(options: { engine: ExpansionEngine; index: RetrievalIndex; query: string; latestMessage: string }): Promise<ExpansionInfo> {
  const topScore = search(options.index, options.query, 1)[0]?.score ?? 0;
  const plan = planExpansion(options.latestMessage, topScore);
  if (!plan.expand) return { triggered: false, reason: plan.reason, language: plan.language, terms: "", ms: 0 };

  const start = performance.now();
  try {
    const reply = await options.engine(buildExpansionPrompt(options.query, plan.targets), EXPANSION_SYSTEM_PROMPT, { timeoutMs: EXPANSION_TIMEOUT_MS, fast: true });
    const terms = reply.ok ? parseExpansionTerms(reply.text) : "";
    return {
      triggered: true,
      reason: plan.reason,
      language: plan.language,
      terms,
      ms: Math.round(performance.now() - start),
      error: reply.ok ? (terms ? undefined : "no usable terms") : String(reply.error ?? "engine failed"),
    };
  } catch (err) {
    return { triggered: true, reason: plan.reason, language: plan.language, terms: "", ms: Math.round(performance.now() - start), error: String((err as Error)?.message ?? err) };
  }
}

/** Pass-1 search with the expansion's terms fused in (the plain search when there are none). The runtime and the benchmark both go through this. */
export function searchWithExpansion(index: RetrievalIndex, query: string, expansion: Pick<ExpansionInfo, "terms" | "reason"> | undefined, depth: number): ScoredChunk[] {
  const base = search(index, query, depth);
  if (!expansion?.terms) return base;
  const weights = fusionWeights(expansion.reason);
  return fuseRankings(
    [
      { results: base, weight: weights.original },
      { results: search(index, expansion.terms, depth), weight: weights.expansion },
    ],
    depth
  );
}
