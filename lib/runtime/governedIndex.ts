import type { Chunk } from "../ingestion/chunk.ts";
import { applyGovernance, type ExcludedContent, type GovernancePolicy, type GovernanceReport } from "../governance/governance.ts";
import type { RegistrySnapshot } from "../governance/registry.ts";
import { buildIndex, type RetrievalIndex } from "../retrieval/index.ts";

export interface GovernedIndex {
  index: RetrievalIndex;
  excluded: ExcludedContent[];
  report: GovernanceReport;
}

/**
 * The only way the runtime builds its retrieval index: governance first,
 * then indexing. Excluded chunks (AI-ineligible, retired, or carrying an
 * identifier the Content Registry does not list) never enter BM25, so they
 * can never be retrieved, prompted, cited or logged. Raw ingestion stays a
 * full inventory of what was loaded; this is the boundary where governance
 * is applied. Both the web route (via the knowledge base) and the terminal
 * tool must use this function rather than calling buildIndex() directly.
 */
export function buildGovernedIndex(chunks: Chunk[], options: { registry?: RegistrySnapshot; policy?: GovernancePolicy } = {}): GovernedIndex {
  const { chunks: eligible, excluded, report } = applyGovernance(chunks, options);
  return { index: buildIndex(eligible), excluded, report };
}
