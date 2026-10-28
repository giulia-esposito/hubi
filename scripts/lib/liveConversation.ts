/**
 * Shared harness for the live evals: one conversation through the real
 * pipeline (ingestion -> governed index -> two-pass retrieval -> Applicability
 * Layer -> prompt -> the configured reasoning provider), exactly as
 * app/api/chat/route.ts runs a turn. Used by scripts/eval-applicability.ts and
 * scripts/validate-pilot.ts. Calls a live model; never imported by tests.
 */
import { ingestContentRepository } from "../../lib/ingestion/ingest.ts";
import { buildGovernedIndex } from "../../lib/runtime/governedIndex.ts";
import { retrieveApplicable } from "../../lib/runtime/retrieveApplicable.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../../lib/runtime/promptBuilder.ts";
import { getReasoningEngine, type ReasoningEngine } from "../../lib/runtime/reasoningEngine.ts";
import { generateWithVerification, shouldVerify, type VerificationInfo } from "../../lib/runtime/verifiedGeneration.ts";
import { extractResponseTags } from "../../lib/runtime/turnKind.ts";
import { formatCitation } from "../../lib/runtime/citationBuilder.ts";
import { regionLabel } from "../../lib/applicability/evaluate.ts";
import type { RetrievalIndex } from "../../lib/retrieval/index.ts";
import type { Turn } from "../../lib/runtime/sessionState.ts";

export interface SourceView {
  citation: string;
  region: string;
  status: string;
  documentId: string;
  text: string;
}

export interface TurnResult {
  question: string;
  text: string;
  turnKind: string;
  planningMode: string;
  /** Applicability gate mode. */
  mode: string;
  taskRegions: string[];
  taskCountries: string[];
  citations: string[];
  statuses: string[];
  sources: SourceView[];
  factPass: { triggered: boolean; reason: string; added: number; query?: string };
  retrievalMs: number;
  modelMs: number;
  totalMs: number;
  withheldRegions: string[];
  mismatchRegions: string[];
  /** Pilot claim guardrail outcome for this turn (buffered=false when the turn streamed normally). */
  verification: VerificationInfo;
}

export interface LiveCorpus {
  index: RetrievalIndex;
  excluded: { contentId: string; aiEligibility: string; chunkCount: number }[];
  chunkCount: number;
}

export function loadCorpus(root = "Content Repository"): LiveCorpus {
  const { chunks } = ingestContentRepository(root);
  const { index, excluded } = buildGovernedIndex(chunks);
  return { index, excluded, chunkCount: chunks.length };
}

const RETRY = /429|RESOURCE_EXHAUSTED|Resource exhausted/i;

/** The configured engine with a 429 retry, so a quota blip cannot masquerade as a model result. */
const retryingEngine: ReasoningEngine = async (prompt, system, opts) => {
  const engine = getReasoningEngine();
  let last = await engine(prompt, system, opts);
  for (let attempt = 1; attempt <= 2 && !last.ok && RETRY.test(String(last.error)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 8000 * attempt));
    last = await engine(prompt, system, opts);
  }
  return last;
};

const NO_VERIFICATION: VerificationInfo = { buffered: false, checked: false, violationsBefore: 0, violationsAfter: 0, revised: false, revisionAccepted: false, phrases: [], extraMs: 0 };

/** One conversation through the real pipeline; returns the result of every turn. */
export async function converse(corpus: LiveCorpus, userMessages: string[]): Promise<TurnResult[]> {
  const history: Turn[] = [];
  const asked: string[] = [];
  const out: TurnResult[] = [];
  let lastPlanningMode: string | undefined;

  for (const question of userMessages) {
    const turnStart = performance.now();
    asked.push(question);
    const { raw, decision, factPass, retrievalMs } = retrieveApplicable(corpus.index, asked.join(" "), asked, { lastPlanningMode });

    let text: string;
    let turnKind = "unknown";
    let planningMode = "unknown";
    let modelMs = 0;
    let verification = NO_VERIFICATION;
    if (raw.length === 0) {
      text = "(deterministic refusal: nothing retrieved)";
      turnKind = "no-grounded-answer";
    } else {
      const modelStart = performance.now();
      // Same path as app/api/chat/route.ts, including the pilot claim guardrail.
      const gated = decision.mode === "must-clarify" || decision.mode === "no-applicable-content";
      const generated = await generateWithVerification({
        engine: retryingEngine,
        prompt: buildPrompt(question, decision.eligible, history, decision),
        systemPrompt: HUBI_SYSTEM_PROMPT,
        retrievedTexts: decision.eligible.map((r) => r.chunk.text),
        verify: shouldVerify(question, lastPlanningMode) && !gated,
      });
      const response = generated.response;
      verification = generated.verification;
      modelMs = performance.now() - modelStart;
      if (!response.ok) throw new Error(`engine error: ${response.error}`);
      ({ text, turnKind, planningMode } = extractResponseTags(response.text));
    }
    lastPlanningMode = planningMode;

    out.push({
      question,
      text,
      turnKind,
      planningMode,
      mode: decision.mode,
      taskRegions: decision.taskRegions,
      taskCountries: decision.taskCountries,
      citations: decision.eligible.map((r) => formatCitation(r.chunk)),
      statuses: decision.eligibleStatuses,
      sources: decision.eligible.map((r, i) => ({
        citation: formatCitation(r.chunk),
        region: regionLabel(r.chunk),
        status: decision.eligibleStatuses[i],
        documentId: r.chunk.documentId,
        text: r.chunk.text,
      })),
      factPass: { triggered: factPass.triggered, reason: factPass.reason, added: factPass.added, query: factPass.query },
      retrievalMs,
      modelMs,
      totalMs: performance.now() - turnStart,
      withheldRegions: decision.withheldRegions,
      mismatchRegions: decision.mismatchRegions,
      verification,
    });
    history.push({ role: "user", content: question }, { role: "assistant", content: text });
  }
  return out;
}
