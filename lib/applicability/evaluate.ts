import type { Chunk } from "../ingestion/chunk.ts";
import type { ScoredChunk } from "../retrieval/index.ts";
import type { AudienceConflict } from "./audience.ts";

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
  /** Operating regions the user's situation falls in (empty when unknown). */
  taskRegions: string[];
  /** Countries the user named; kept separate from the operating region they resolve to. */
  taskCountries: string[];
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
  /**
   * When a conditional fact-retrieval pass added chunks, the number of
   * leading chunks in `eligible` that came from it (the facts); the rest came
   * from the pass that matched the request's own wording (references).
   */
  factSourceCount?: number;
  /** How many of the eligible chunks have unspecified scope. */
  unspecifiedUsed: number;
  /** Set when the eligible sources are written for different audiences and the user has not said which applies (lib/applicability/audience.ts). */
  audienceConflict?: AudienceConflict;
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
export function applyApplicability(
  taskRegions: string[],
  ranked: ScoredChunk[],
  topK: number,
  options: { gate?: boolean; regionCue?: boolean } = {}
): ApplicabilityDecision {
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

  // The user said the answer depends on their own region and did not state it:
  // if region-specific material was withheld, asking is mandatory, even when
  // better-ranked Global or unspecified content exists.
  if (options.regionCue && taskRegions.length === 0 && withheldInWindow.length > 0 && mode !== "must-clarify") {
    mode = "must-clarify";
  }

  // A supplemental retrieval pass only filters: the first pass alone decides whether the turn is gated.
  if (options.gate === false && (mode === "must-clarify" || mode === "no-applicable-content")) {
    mode = withheldInWindow.length > 0 ? "notice" : "none";
  }

  const gated = mode === "must-clarify" || mode === "no-applicable-content";
  const kept = gated ? [] : eligibleIdx.slice(0, topK);

  return {
    taskRegions,
    taskCountries: [],
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

/**
 * Appends the extra chunks from a second retrieval pass (already filtered by
 * applyApplicability on that pass) to the first pass's decision. The first
 * pass alone decides the gate: a second pass only runs when the first ended in
 * "none" or "notice", and it can only add content or widen the notice.
 */
export function mergeSupplementalDecision(first: ApplicabilityDecision, extra: ApplicabilityDecision): ApplicabilityDecision {
  const seen = new Set(first.eligible.map((r) => r.chunk.id));
  const addedIdx = extra.eligible.map((r, i) => i).filter((i) => !seen.has(extra.eligible[i].chunk.id));
  // Facts first, then the references that matched the request's wording: the
  // prompt (and therefore the citation numbering) presents them in this order.
  const eligible = [...addedIdx.map((i) => extra.eligible[i]), ...first.eligible];
  const eligibleStatuses = [...addedIdx.map((i) => extra.eligibleStatuses[i]), ...first.eligibleStatuses];
  const withheldRegions = distinct([...first.withheldRegions, ...extra.withheldRegions]);
  const mode: ApplicabilityMode = first.mode === "none" && extra.withheldCount > 0 ? "notice" : first.mode;
  return {
    ...first,
    mode,
    eligible,
    eligibleStatuses,
    factSourceCount: addedIdx.length,
    withheldRegions,
    mismatchRegions: distinct([...first.mismatchRegions, ...extra.mismatchRegions]),
    withheldCount: first.withheldCount + extra.withheldCount,
    mismatchCount: first.mismatchCount + extra.mismatchCount,
    unspecifiedUsed: eligibleStatuses.filter((s) => s === "unspecified").length,
  };
}
