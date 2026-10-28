import { search, tokenize, type RetrievalIndex, type ScoredChunk } from "../retrieval/index.ts";

/**
 * Conditional fact-retrieval pass (Finding #004, smallest version).
 *
 * Problem: a request to CREATE something ("write a pitch", "draft an email",
 * "create a talk track") names the kind of document, so BM25 returns craft and
 * reference documents about that kind of document, while the facts needed to
 * fill the artifact live in product/positioning content that never uses those
 * words. Pass 1 is unchanged; when it returns guidance but too few
 * fact-bearing chunks for an artifact request, one targeted second BM25 pass
 * fetches the facts.
 *
 * Deterministic, BM25 only, no model call, no new dependency. It is not
 * artifact-specific: nothing here names a pitch, an email or any other
 * artifact. AI Eligibility already applies (the index is governed) and the
 * caller applies the Applicability Layer to this pass exactly as to pass 1.
 */

/** How many extra chunks the second pass may add. */
export const FACT_K = 4;
const FACT_RETRIEVAL_DEPTH = 15;
/** Pass-1 chunks must appear in this many top fact-bearing hits to count as fact-bearing. */
const FACT_COVERAGE_WINDOW = 40;
/** Fewer fact-bearing chunks than this in pass 1 means the facts are thin. */
const MIN_FACT_CHUNKS = 2;

/**
 * What "fact-bearing" content looks like for this corpus: descriptive product
 * content (what the product is, who it serves, what it does, how clients
 * engage with it). Configurable constant, domain-level and artifact-agnostic;
 * tuned against the real corpus, where this query surfaces the product and
 * value content that craft documents do not contain.
 */
export const FACT_ANCHOR_QUERY = "what is Wellhub corporate wellbeing employees engagement benefits platform";

// Creation / adaptation verbs, general across artifact types (English, Spanish, Portuguese).
const CREATION_REQUEST =
  /\b(write|draft|create|build|prepare|compose|generate|craft|develop|put together|come up with|make me|make a|tailor|adapt|rewrite|escribe|escribir|redacta|redactar|crea|crear|prepara|preparar|genera|generar|elabora|elaborar|arma|armar|adapta|adaptar|escreva|escrever|redija|redigir|crie|criar|prepare|preparar|gere|gerar|elabore|elaborar|monte|montar|adapte|adaptar)\b/i;

/**
 * Whether this turn asks for something to be created. The planning mode is
 * only known after the model answers, so this deterministic check only gates
 * the retrieval top-up; it never decides the planning mode itself. A short
 * follow-up that adds context to a previous business-assistance turn counts as
 * a continuation.
 */
export function isArtifactRequest(latestUserMessage: string, lastPlanningMode?: string): boolean {
  if (CREATION_REQUEST.test(latestUserMessage)) return true;
  return lastPlanningMode === "business-assistance" && !latestUserMessage.includes("?");
}

// Words that instruct rather than describe, dropped from the second-pass query.
const INSTRUCTION_WORDS = new Set([
  "write", "create", "draft", "prepare", "build", "compose", "generate", "craft", "develop", "make", "tailor", "adapt",
  "rewrite", "please", "help", "need", "give", "show", "tell", "short", "quick", "brief", "minute", "minutes", "min",
  "new", "finished", "full", "ready", "version", "something", "good", "great", "best", "could", "can", "like", "want",
  "escribe", "escribir", "redacta", "crea", "crear", "prepara", "genera", "elabora", "arma", "adapta", "necesito",
  "escreva", "redija", "crie", "gere", "elabore", "monte", "adapte", "preciso", "um", "una", "uno",
]);

export interface FactPassInfo {
  triggered: boolean;
  reason: "not-artifact-request" | "gated" | "facts-present" | "triggered";
  /** The second-pass query, when one was run. */
  query?: string;
  /** Pass-1 chunks that already look fact-bearing. */
  factChunksInPassOne: number;
  /** Chunks the second pass added after applicability filtering (set by the caller). */
  added: number;
}

/** How many of the pass-1 chunks are among the top fact-bearing hits. */
export function countFactBearing(index: RetrievalIndex, passOne: ScoredChunk[]): number {
  const factIds = new Set(search(index, FACT_ANCHOR_QUERY, FACT_COVERAGE_WINDOW).map((r) => r.chunk.id));
  return passOne.filter((r) => factIds.has(r.chunk.id)).length;
}

export function factsAreThin(index: RetrievalIndex, passOne: ScoredChunk[]): { thin: boolean; factChunks: number } {
  const factChunks = countFactBearing(index, passOne);
  return { thin: factChunks < MIN_FACT_CHUNKS, factChunks };
}

/**
 * Builds the second-pass query: the fact-bearing anchor plus the request's
 * remaining context terms. Terms that instruct are dropped, and so is every
 * term found in the headings or titles of the pass-1 top chunks: those terms
 * name the kind of reference document pass 1 found (what is being asked for),
 * not the facts to populate it with.
 */
export function buildFactQuery(userMessages: string[], passOneTop: ScoredChunk[]): string {
  const referenceTerms = new Set<string>();
  for (const r of passOneTop.slice(0, 3)) {
    for (const t of tokenize(`${r.chunk.heading ?? ""} ${r.chunk.documentTitle}`)) referenceTerms.add(t);
  }
  const context = new Set<string>();
  for (const t of tokenize(userMessages.join(" "))) {
    if (INSTRUCTION_WORDS.has(t) || referenceTerms.has(t)) continue;
    context.add(t);
  }
  return [FACT_ANCHOR_QUERY, ...context].join(" ");
}

export function runFactPass(index: RetrievalIndex, query: string): ScoredChunk[] {
  return search(index, query, FACT_RETRIEVAL_DEPTH);
}
