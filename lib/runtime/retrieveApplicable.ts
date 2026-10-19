import { applyApplicability, type ApplicabilityDecision } from "../applicability/evaluate.ts";
import { detectTaskRegions, getRegionVocabulary, type RegionVocabulary } from "../applicability/regions.ts";
import { search, type RetrievalIndex, type ScoredChunk } from "../retrieval/index.ts";

export const TOP_K = 5;
// Retrieval is over-fetched so that withholding region-specific chunks does
// not starve the answer set: fetch more, filter, then keep the best TOP_K.
export const OVER_FETCH_K = 15;

export interface ApplicableRetrieval {
  /** The raw ranked results before applicability filtering (empty means retrieval found nothing at all). */
  raw: ScoredChunk[];
  decision: ApplicabilityDecision;
}

/**
 * Retrieval, then the Applicability Layer. Retrieval itself is unchanged
 * (same BM25, same query); applicability is a pure post-filter. Region
 * detection reads only the user's own messages.
 */
export function retrieveApplicable(
  index: RetrievalIndex,
  retrievalQuery: string,
  userMessages: string[],
  vocabulary: RegionVocabulary = getRegionVocabulary()
): ApplicableRetrieval {
  const raw = search(index, retrievalQuery, OVER_FETCH_K);
  const taskRegions = detectTaskRegions(vocabulary, userMessages);
  return { raw, decision: applyApplicability(taskRegions, raw, TOP_K) };
}
