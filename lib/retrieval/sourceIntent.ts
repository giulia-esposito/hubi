import type { Chunk } from "../ingestion/chunk.ts";
import { classifyChunk, type ChunkRegionStatus } from "../applicability/evaluate.ts";
import { search, type RetrievalIndex, type ScoredChunk } from "./index.ts";
import { sourceFactsOf } from "../governance/sourceFacts.ts";
import { isUpdateSource } from "../governance/sourceGovernance.ts";

/**
 * Intent-aware reserved slots (docs/source-selection-design.md, section 3). BM25 ranks by wording, so a newsletter that
 * announces a training can fill the answer set and push out the training that holds the steps, and a "what changed" question
 * can miss the newsletters that hold the changes. Nothing is rescored or penalised: a deterministic cue reads what the user is
 * asking for, and when the answer set holds no source of the kind that cue needs, the best one from a deeper search is added,
 * provided it matches the wording nearly as well as the best result. No model call.
 */

export type SourceIntent = "process" | "recency";

const PROCESS_CUE =
  /\b(how (?:do|does|can|should|would|to)\b|steps?\b|process(?:es)?\b|procedure|walk me through|what do i (?:need to )?do|checklist|playbook|guide me|como (?:fa[cç]o|se faz)|c[oó]mo (?:hago|se hace)|passo a passo|paso a paso|pasos|proceso|processo)/i;
const RECENCY_CUE =
  /\b(what(?:'s| is| has| have)? (?:new|changed)|what changed|any(?:thing)? new|latest|recent(?:ly)?|this week|last week|this month|updates?\b|announce\w*|novedades|novidades|[uú]ltimas?|o que mudou|qu[eé] cambi[oó])/i;

export function detectSourceIntents(question: string): SourceIntent[] {
  const intents: SourceIntent[] = [];
  if (PROCESS_CUE.test(question)) intents.push("process");
  if (RECENCY_CUE.test(question)) intents.push("recency");
  return intents;
}

/** Registered and not an update source: a training, wiki page, coaching session or deck. Unregistered files have no type, so they count as neither. */
function kindOf(chunk: Chunk): "process" | "update" | null {
  const f = sourceFactsOf(chunk);
  if (!f.contentType) return null;
  return isUpdateSource(f.contentType, f.collection) ? "update" : "process";
}

export const INTENT_PASS_DEPTH = 150;
export const INTENT_PASS_MIN_RELATIVE_SCORE = 0.5;

export interface IntentPassInfo {
  intents: SourceIntent[];
  /** What was added, with the intent that asked for it. */
  added: { intent: SourceIntent; chunkId: string; documentId: string }[];
}

export interface IntentPassResult {
  eligible: ScoredChunk[];
  statuses: ChunkRegionStatus[];
  info: IntentPassInfo;
}

export function applyIntentSlots(
  index: RetrievalIndex,
  query: string,
  question: string,
  eligible: ScoredChunk[],
  statuses: ChunkRegionStatus[],
  taskRegions: string[],
  bestScore: number
): IntentPassResult {
  const intents = detectSourceIntents(question);
  const info: IntentPassInfo = { intents, added: [] };
  if (intents.length === 0 || bestScore <= 0) return { eligible, statuses, info };

  const out = [...eligible];
  const outStatuses = [...statuses];
  let candidates: ScoredChunk[] | undefined;
  for (const intent of intents) {
    const wanted = intent === "process" ? "process" : "update";
    if (out.some((r) => kindOf(r.chunk) === wanted)) continue; // already represented
    candidates ??= search(index, query, INTENT_PASS_DEPTH).filter((r) => {
      const s = classifyChunk(r.chunk, taskRegions);
      // Same footing as the first pass: a source of unknown region may be used (and is labelled so), region-specific content for another or an unknown region may not.
      return r.score >= bestScore * INTENT_PASS_MIN_RELATIVE_SCORE && (s === "global" || s === "match" || s === "unspecified");
    });
    const pool = candidates.filter((r) => kindOf(r.chunk) === wanted && !out.some((o) => o.chunk.id === r.chunk.id));
    // Updates: the newest wins (a dated one beats an undated one); processes: the best match.
    const pick =
      intent === "recency"
        ? [...pool].sort((a, b) => (sourceFactsOf(b.chunk).date?.iso ?? "").localeCompare(sourceFactsOf(a.chunk).date?.iso ?? "") || b.score - a.score)[0]
        : pool[0];
    if (!pick) continue;
    out.push(pick);
    outStatuses.push(classifyChunk(pick.chunk, taskRegions));
    info.added.push({ intent, chunkId: pick.chunk.id, documentId: pick.chunk.documentId });
  }
  return { eligible: out, statuses: outStatuses, info };
}
