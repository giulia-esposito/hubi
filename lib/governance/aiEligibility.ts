import type { Chunk } from "../ingestion/chunk.ts";

/**
 * AI Eligibility is a governance gate, not a retrieval optimization
 * (Finding #002 product decision). Content the registry marks Not Eligible
 * or Pending Assessment must never reach retrieval, prompts, citations or
 * logs.
 *
 * This is the smallest deterministic version: an explicit deny-list of
 * Content IDs known to be ineligible, applied before the retrieval index is
 * built. It is a stopgap for registry sync (docs/context-applicability-
 * architecture.md Section 5), which stays out of scope: a Not Eligible
 * document that is not on this list remains retrievable until that sync
 * exists. Keep this list in step with the registry.
 *
 * It is a TypeScript constant, not a data file, so it is always bundled with
 * the code and the gate can never silently fail open because a file is
 * missing from a deployed image.
 */
export interface AiEligibilityExclusion {
  contentId: string;
  aiEligibility: "Not Eligible" | "Pending Assessment";
  /** Where this was read, for audit. */
  source: string;
  recordedAt: string;
}

export const AI_ELIGIBILITY_EXCLUSIONS: readonly AiEligibilityExclusion[] = [
  {
    contentId: "RKC-000021",
    aiEligibility: "Not Eligible",
    source: "RKC | Revenue Knowledge Center - Content Registry (live read via Drive connector, 2026-07-21)",
    recordedAt: "2026-07-21",
  },
];

export interface ExcludedContent {
  contentId: string;
  aiEligibility: string;
  chunkCount: number;
}

export interface EligibilityResult {
  chunks: Chunk[];
  excluded: ExcludedContent[];
}

/** Removes every chunk of an excluded document. Matches on the chunk's document (Content ID). */
export function excludeIneligible(chunks: Chunk[], exclusions: readonly AiEligibilityExclusion[] = AI_ELIGIBILITY_EXCLUSIONS): EligibilityResult {
  const byId = new Map(exclusions.map((e) => [e.contentId, e]));
  const counts = new Map<string, number>();
  const kept: Chunk[] = [];
  for (const chunk of chunks) {
    if (byId.has(chunk.documentId)) {
      counts.set(chunk.documentId, (counts.get(chunk.documentId) ?? 0) + 1);
    } else {
      kept.push(chunk);
    }
  }
  const excluded = [...counts].map(([contentId, chunkCount]) => ({
    contentId,
    aiEligibility: byId.get(contentId)!.aiEligibility,
    chunkCount,
  }));
  return { chunks: kept, excluded };
}
