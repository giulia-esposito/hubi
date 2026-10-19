import type { Chunk } from "../ingestion/chunk.ts";
import { excludeIneligible, type ExcludedContent } from "../governance/aiEligibility.ts";
import { buildIndex, type RetrievalIndex } from "../retrieval/index.ts";

export interface GovernedIndex {
  index: RetrievalIndex;
  excluded: ExcludedContent[];
}

/**
 * The only way the runtime builds its retrieval index: governance first,
 * then indexing. Excluded (AI-ineligible) chunks never enter BM25, so they
 * can never be retrieved, prompted, cited or logged. Raw ingestion stays a
 * full inventory of what was loaded; this is the boundary where governance
 * is applied. Both the web route (via the knowledge base) and the terminal
 * tool must use this function rather than calling buildIndex() directly.
 */
export function buildGovernedIndex(chunks: Chunk[]): GovernedIndex {
  const { chunks: eligible, excluded } = excludeIneligible(chunks);
  return { index: buildIndex(eligible), excluded };
}
