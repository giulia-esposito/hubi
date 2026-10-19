import type { Chunk } from "../ingestion/chunk.ts";
import type { ScoredChunk } from "../retrieval/index.ts";

/**
 * Applicability evaluation (Finding #002): a pure, deterministic function
 * over already-retrieved chunks. It never queries the index, so a future
 * second retrieval pass (Finding #004) can merge its results first and be
 * filtered by the same call. No model is involved.
 *
 * Per-chunk status:
 *   global      the metadata literally says Global
 *   match       regional, and the user's region is one of the chunk's regions
 *   mismatch    regional, the user's region is known, and it is not listed
 *   unresolved  regional, and the user's region is not known
 *   unspecified no usable region metadata: scope unknown. NEVER treated as
 *               Global and NEVER as a match.
 */
export type ChunkRegionStatus = "global" | "match" | "mismatch" | "unresolved" | "unspecified";

/** Exact visible/logged label for chunks with no usable region metadata. */
export const UNSPECIFIED_REGION_LABEL = "not specified in source metadata";

export function classifyChunk(chunk: Chunk, taskRegions: string[]): ChunkRegionStatus {
  const scope = chunk.regionScope ?? "unspecified";
  if (scope === "global") return "global";
  if (scope === "unspecified") return "unspecified";
  if (taskRegions.length === 0) return "unresolved";
  const regions = chunk.regions ?? [];
  return regions.some((r) => taskRegions.includes(r)) ? "match" : "mismatch";
}

/** The region part of a source label, as shown in the prompt, citations, UI and logs. */
export function regionLabel(chunk: Chunk): string {
  const scope = chunk.regionScope ?? "unspecified";
  if (scope === "global") return "Global";
  if (scope === "regional" && chunk.regions && chunk.regions.length > 0) return chunk.regions.join(", ");
  return UNSPECIFIED_REGION_LABEL;
}

export type ApplicabilityMode =
  /** Nothing withheld; answer normally. */
  | "none"
  /** Region-specific material was withheld because the user's region is unknown; the answer may still use the rest. */
  | "notice"
  /** The best-ranked material is region-specific and the region is unknown (or nothing eligible remains): ask first, send no content. */
  | "must-clarify"
  /** The user's region is known but every retrieved chunk is for other regions: say there is no approved content. */
  | "no-applicable-content";

export interface ApplicabilityDecision {
  taskRegions: string[];
  mode: ApplicabilityMode;
  /** Chunks the model may see, in rank order, at most topK. Empty in the two gate modes. */
  eligible: ScoredChunk[];
  /** Status of each eligible chunk, parallel to `eligible`. */
  eligibleStatuses: ChunkRegionStatus[];
  /** Regions of region-specific chunks withheld because the user's region is unknown (within the top-K window). */
  withheldRegions: string[];
  /** Regions of chunks excluded because they do not apply to the user's known region (within the top-K window). */
  mismatchRegions: string[];
  withheldCount: number;
  mismatchCount: number;
  /** How many of the eligible chunks have unspecified scope. */
  unspecifiedUsed: number;
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Filters retrieved chunks (already ranked, normally over-fetched) down to
 * what the model may see, and decides whether the turn must clarify first.
 *
 * Rules:
 *  - mismatch chunks are never passed on.
 *  - unresolved chunks are withheld until the user's region is known.
 *  - must-clarify when the top-ranked chunk is unresolved, or when nothing
 *    eligible remains but something was withheld: the answer would be built
 *    on region-specific content the user has not scoped, so no content is sent.
 *  - no-applicable-content when the region is known and everything retrieved
 *    belongs to other regions.
 *  - notice/must-clarify consider only the top-K window of the ranking, so a
 *    low-ranked regional chunk cannot force a question on its own.
 */
export function applyApplicability(taskRegions: string[], ranked: ScoredChunk[], topK: number): ApplicabilityDecision {
  const statuses = ranked.map((r) => classifyChunk(r.chunk, taskRegions));

  const eligibleIdx: number[] = [];
  statuses.forEach((s, i) => {
    if (s === "global" || s === "match" || s === "unspecified") eligibleIdx.push(i);
  });

  const windowEnd = Math.min(topK, ranked.length);
  const withheldInWindow: Chunk[] = [];
  const mismatchInWindow: Chunk[] = [];
  for (let i = 0; i < windowEnd; i++) {
    if (statuses[i] === "unresolved") withheldInWindow.push(ranked[i].chunk);
    if (statuses[i] === "mismatch") mismatchInWindow.push(ranked[i].chunk);
  }
  const withheldRegions = distinct(withheldInWindow.flatMap((c) => c.regions ?? []));
  const mismatchRegions = distinct(mismatchInWindow.flatMap((c) => c.regions ?? []));

  const topUnresolved = ranked.length > 0 && statuses[0] === "unresolved";
  const nothingEligible = eligibleIdx.length === 0;

  let mode: ApplicabilityMode = "none";
  if (ranked.length > 0) {
    if (topUnresolved || (nothingEligible && withheldInWindow.length > 0)) mode = "must-clarify";
    else if (nothingEligible && mismatchInWindow.length > 0) mode = "no-applicable-content";
    else if (withheldInWindow.length > 0) mode = "notice";
  }

  const gated = mode === "must-clarify" || mode === "no-applicable-content";
  const kept = gated ? [] : eligibleIdx.slice(0, topK);

  return {
    taskRegions,
    mode,
    eligible: kept.map((i) => ranked[i]),
    eligibleStatuses: kept.map((i) => statuses[i]),
    withheldRegions,
    mismatchRegions,
    withheldCount: withheldInWindow.length,
    mismatchCount: mismatchInWindow.length,
    unspecifiedUsed: kept.filter((i) => statuses[i] === "unspecified").length,
  };
}
