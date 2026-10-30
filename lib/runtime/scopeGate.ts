import type { ApplicabilityDecision } from "../applicability/evaluate.ts";
import { judgeScope, type ScopeEngine, type ScopeGroup } from "../applicability/scopeClarification.ts";

/** Region plus one more dimension: a third question in one topic is a form, not a conversation. */
export const MAX_CLARIFICATIONS_PER_TOPIC = 2;

export interface ScopeGateOutcome {
  decision: ApplicabilityDecision;
  /** Present when the judge ran: whether it asked, and what the candidate situations were. */
  judged?: { asked: boolean; question?: string; ms: number; error?: string; groups: string[][] };
}

/**
 * Turns a "the answer differs by situation and the user has not said which" finding into a gated turn. Runs only when retrieval
 * found candidate situations (lib/applicability/scopeClarification.ts), so a general question costs nothing here. A gated turn sends
 * no source content to the model, exactly like the region gate: the model only phrases the question.
 */
export async function applyScopeGate(
  engine: ScopeEngine,
  decision: ApplicabilityDecision,
  candidates: ScopeGroup[] | null,
  question: string,
  userMessages: string[],
  clarificationsAlreadyAsked = 0
): Promise<ScopeGateOutcome> {
  if (!candidates || decision.mode === "must-clarify" || decision.mode === "no-applicable-content") return { decision };
  // The user has already been asked as much as one topic should cost (the region question counts): take the reply as the answer and proceed.
  if (clarificationsAlreadyAsked >= MAX_CLARIFICATIONS_PER_TOPIC) return { decision };
  const verdict = await judgeScope(engine, question, userMessages, candidates);
  const groups = candidates.map((g) => g.audience);
  if (!verdict.question) return { decision, judged: { asked: false, ms: verdict.ms, error: verdict.error, groups } };
  return {
    decision: { ...decision, mode: "must-clarify", clarifyReason: "scope-conflict", clarifyQuestion: verdict.question, eligible: [], eligibleStatuses: [], withheldRegions: [], withheldCount: 0, factSourceCount: undefined, unspecifiedUsed: 0 },
    judged: { asked: true, question: verdict.question, ms: verdict.ms, groups },
  };
}
