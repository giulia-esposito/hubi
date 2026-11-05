import { applyApplicability, classifyChunk, mergeSupplementalDecision, type ApplicabilityDecision } from "../applicability/evaluate.ts";
import { detectTaskContext, getRegionVocabulary, refersToOwnRegion, type RegionVocabulary } from "../applicability/regions.ts";
import { search, tokenize, type RetrievalIndex, type ScoredChunk } from "../retrieval/index.ts";
import { searchWithExpansion, type ExpansionInfo } from "../retrieval/queryExpansion.ts";
import { detectAudienceConflict } from "../applicability/audience.ts";
import { searchContext } from "./sessionState.ts";
import { inferRegionFromLanguage, languageRegionEnabled } from "../applicability/languageRegion.ts";
import { applyIntentSlots, type IntentPassInfo } from "../retrieval/sourceIntent.ts";
import { findScopeCandidates, type ScopeGroup } from "../applicability/scopeClarification.ts";
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

// A region-specific chunk this close to the best match (and the region unknown) means the question is about regional material:
// ask for the region rather than answer from weaker generic sources. Calibrated on the 60 known questions (docs/context-asking-eval.md).
export const STRONG_REGIONAL_RATIO = 0.7;

// Once the user has stated a region, material written for that region gets a fair chance: the best few chunks for it, from a
// deeper search, are added when they score at least this share of the best chunk. Found in production: after Hubi asked for the
// region and the user said "Tier 1 in Mexico", the Spanish SS Latam onboarding training still never reached the top five, so the
// question was answered with a dead end. The deeper search needs no model call.
export const REGION_PASS_DEPTH = 150;
export const SCOPE_PROBE_DEPTH = 60;
export const REGION_PASS_K = 2;
export const REGION_PASS_MIN_RELATIVE_SCORE = 0.5;

const plain = (word: string) => word.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * The cross-language terms were written for the whole conversation, replies included ("Tier 1 in Mexico"). Candidate situations must be about
 * the question itself, so the words of the replies are taken out of the terms: otherwise a reply's "Tier" pulls in a contract training for an
 * onboarding question.
 */
function withoutReplyWords(expansion: RetrieveOptions["expansion"], replies: string[]): RetrieveOptions["expansion"] {
  if (!expansion || replies.length === 0) return expansion;
  const replyWords = new Set((replies.join(" ").match(/[\p{L}\p{N}]+/gu) ?? []).map(plain));
  return { ...expansion, terms: expansion.terms.split(/\s+/).filter((w) => w && !replyWords.has(plain(w))).join(" ") };
}

export interface ApplicableRetrieval {
  /** The raw ranked results of pass 1, before applicability filtering (empty means retrieval found nothing at all). */
  raw: ScoredChunk[];
  decision: ApplicabilityDecision;
  /** What the conditional fact pass did (Finding #004). */
  factPass: FactPassInfo;
  /** Intent-aware reserved slots (docs/source-selection-design.md): the cue read from the question and any source added for it. */
  intentPass: IntentPassInfo;
  /** Situations the question could be about, from documents written for audiences that share no label; null when there are none. The scope gate decides whether to ask (lib/runtime/scopeGate.ts). */
  scopeCandidates: ScopeGroup[] | null;
  /** Wall-clock milliseconds spent in retrieval, both passes and applicability included. */
  retrievalMs: number;
  /** Where the user's region came from: a message in the window, the pinned context, or nowhere. */
  regionSource: "message" | "pinned" | "language" | "none";
}

export interface RetrieveOptions {
  vocabulary?: RegionVocabulary;
  /** planningMode reported on the previous turn, so a short follow-up can continue an artifact request. */
  lastPlanningMode?: string;
  /** Region and country in force after the previous turn; used only when no message in the window names a region. */
  pinned?: { regions: string[]; countries: string[] };
  /**
   * Cross-language search terms already produced for this turn (lib/retrieval/queryExpansion.ts). When present,
   * pass 1 searches the index with them as well and fuses the two rankings; everything after pass 1 is unchanged.
   */
  expansion?: Pick<ExpansionInfo, "terms" | "reason">;
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
  let regionSource: "message" | "pinned" | "language" | "none" = context.regions.length > 0 ? "message" : "none";
  if (context.regions.length === 0 && options.pinned && options.pinned.regions.length > 0) {
    context = { regions: options.pinned.regions, countries: options.pinned.countries };
    regionSource = "pinned";
  }
  // Weakest signal, used only when nothing else names a region: the question's own language, for the languages Product approved.
  if (context.regions.length === 0 && languageRegionEnabled()) {
    const inferred = inferRegionFromLanguage(userMessages);
    if (inferred) {
      context = { regions: [inferred], countries: [] };
      regionSource = "language";
    }
  }

  const raw = searchWithExpansion(index, retrievalQuery, options.expansion, OVER_FETCH_K);
  let decision: ApplicabilityDecision = { ...applyApplicability(context.regions, raw, TOP_K, { regionCue: userMessages.some(refersToOwnRegion), strongRegionalRatio: STRONG_REGIONAL_RATIO, queryTerms: tokenize(retrievalQuery) }), taskCountries: context.countries };
  let factPass: FactPassInfo = { triggered: false, reason: "not-artifact-request", factChunksInPassOne: 0, added: 0 };

  // A known region: add the best chunks written for it that the first pass left out.
  if (context.regions.length > 0 && decision.mode !== "must-clarify" && decision.mode !== "no-applicable-content" && raw.length > 0) {
    const seen = new Set(decision.eligible.map((r) => r.chunk.id));
    const floor = raw[0].score * REGION_PASS_MIN_RELATIVE_SCORE;
    // The same cross-language search as pass 1: the document written for the user's region is often in that region's language.
    const regional = searchWithExpansion(index, retrievalQuery, options.expansion, REGION_PASS_DEPTH)
      .filter((r) => r.score >= floor && !seen.has(r.chunk.id) && classifyChunk(r.chunk, context.regions) === "match")
      .slice(0, REGION_PASS_K);
    if (regional.length > 0) {
      decision = { ...decision, eligible: [...regional, ...decision.eligible], eligibleStatuses: [...regional.map(() => "match" as const), ...decision.eligibleStatuses] };
    }
  }

  const latest = userMessages[userMessages.length - 1] ?? "";
  let intentPass: IntentPassInfo = { intents: [], added: [] };
  if (decision.mode !== "must-clarify" && decision.mode !== "no-applicable-content" && raw.length > 0) {
    const slots = applyIntentSlots(index, retrievalQuery, latest, decision.eligible, decision.eligibleStatuses, context.regions, raw[0].score, options.expansion);
    decision = { ...decision, eligible: slots.eligible, eligibleStatuses: slots.statuses, unspecifiedUsed: slots.statuses.filter((s) => s === "unspecified").length };
    intentPass = slots.info;
  }
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

  // Sources written for different audiences, with the user's own audience unstated: the prompt says so.
  if (decision.mode !== "must-clarify" && decision.mode !== "no-applicable-content") {
    const conflict = detectAudienceConflict(decision.eligible, userMessages);
    if (conflict) decision = { ...decision, audienceConflict: conflict };
  }

  // Candidate situations: the documents that best match the QUESTION (not the replies that supplied context, which would pull in documents on other topics),
  // from a deeper cross-language search limited to what the Applicability Layer lets through. Not for requests to create something: those proceed on stated assumptions.
  let scopeCandidates: ScopeGroup[] | null = null;
  if (decision.mode !== "must-clarify" && decision.mode !== "no-applicable-content" && raw.length > 0 && !isArtifactRequest(latest, options.lastPlanningMode)) {
    const letThrough = (r: ScoredChunk) => {
      const s = classifyChunk(r.chunk, context.regions);
      return s === "global" || s === "match" || s === "unspecified";
    };
    const topic = searchContext(userMessages);
    const pool = searchWithExpansion(index, topic.anchor, withoutReplyWords(options.expansion, userMessages.slice(topic.start + 1)), SCOPE_PROBE_DEPTH).filter(letThrough);
    scopeCandidates = findScopeCandidates(pool, pool[0]?.score ?? 0);
  }

  return { raw, decision, factPass, intentPass, scopeCandidates, retrievalMs: performance.now() - start, regionSource };
}
