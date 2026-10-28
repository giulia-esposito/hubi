import { applyApplicability, mergeSupplementalDecision, type ApplicabilityDecision } from "../applicability/evaluate.ts";
import { detectTaskContext, getRegionVocabulary, refersToOwnRegion, type RegionVocabulary } from "../applicability/regions.ts";
import { search, type RetrievalIndex, type ScoredChunk } from "../retrieval/index.ts";
import {
  FACT_K,
  buildFactQuery,
  factsAreThin,
  isArtifactRequest,
  runFactPass,
  type FactPassInfo,
} from "./factRetrieval.ts";

export const TOP_K = 5;
// Retrieval is over-fetched so that withholding region-specific chunks does
// not starve the answer set: fetch more, filter, then keep the best TOP_K.
export const OVER_FETCH_K = 15;

export interface ApplicableRetrieval {
  /** The raw ranked results of pass 1, before applicability filtering (empty means retrieval found nothing at all). */
  raw: ScoredChunk[];
  decision: ApplicabilityDecision;
  /** What the conditional fact pass did (Finding #004). */
  factPass: FactPassInfo;
  /** Wall-clock milliseconds spent in retrieval, both passes and applicability included. */
  retrievalMs: number;
  /** Where the user's region came from: a message in the window, the pinned context, or nowhere. */
  regionSource: "message" | "pinned" | "none";
}

export interface RetrieveOptions {
  vocabulary?: RegionVocabulary;
  /** planningMode reported on the previous turn, so a short follow-up can continue an artifact request. */
  lastPlanningMode?: string;
  /** Region and country in force after the previous turn; used only when no message in the window names a region. */
  pinned?: { regions: string[]; countries: string[] };
}

/**
 * Pass 1: BM25 over the governed index (unchanged), then the Applicability
 * Layer. Pass 2 (conditional): when the turn asks for something to be created
 * and pass 1 returned too few fact-bearing chunks, one targeted BM25 pass for
 * the facts, filtered by the same Applicability Layer and appended. AI
 * Eligibility applies to both passes because the index itself is governed.
 * Region detection reads only the user's own messages. No model call.
 */
export function retrieveApplicable(
  index: RetrievalIndex,
  retrievalQuery: string,
  userMessages: string[],
  options: RetrieveOptions = {}
): ApplicableRetrieval {
  const start = performance.now();
  const vocabulary = options.vocabulary ?? getRegionVocabulary();
  let context = detectTaskContext(vocabulary, userMessages);
  // A region stated in a message always wins; the pinned region only fills in when
  // that message has fallen out of the history window.
  let regionSource: "message" | "pinned" | "none" = context.regions.length > 0 ? "message" : "none";
  if (context.regions.length === 0 && options.pinned && options.pinned.regions.length > 0) {
    context = { regions: options.pinned.regions, countries: options.pinned.countries };
    regionSource = "pinned";
  }

  const raw = search(index, retrievalQuery, OVER_FETCH_K);
  let decision: ApplicabilityDecision = { ...applyApplicability(context.regions, raw, TOP_K, { regionCue: userMessages.some(refersToOwnRegion) }), taskCountries: context.countries };
  let factPass: FactPassInfo = { triggered: false, reason: "not-artifact-request", factChunksInPassOne: 0, added: 0 };

  const latest = userMessages[userMessages.length - 1] ?? "";
  if (isArtifactRequest(latest, options.lastPlanningMode)) {
    if (decision.mode === "must-clarify" || decision.mode === "no-applicable-content") {
      factPass = { triggered: false, reason: "gated", factChunksInPassOne: 0, added: 0 };
    } else {
      const { thin, factChunks } = factsAreThin(index, decision.eligible);
      if (!thin) {
        factPass = { triggered: false, reason: "facts-present", factChunksInPassOne: factChunks, added: 0 };
      } else {
        const query = buildFactQuery(userMessages, decision.eligible);
        const extra = applyApplicability(context.regions, runFactPass(index, query), FACT_K, { gate: false });
        const before = decision.eligible.length;
        decision = mergeSupplementalDecision(decision, { ...extra, eligible: extra.eligible.slice(0, FACT_K) });
        factPass = { triggered: true, reason: "triggered", query, factChunksInPassOne: factChunks, added: decision.eligible.length - before };
      }
    }
  }

  return { raw, decision, factPass, retrievalMs: performance.now() - start, regionSource };
}
