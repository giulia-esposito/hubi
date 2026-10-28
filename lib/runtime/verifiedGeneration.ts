import type { ReasoningEngine, ReasoningResult } from "./reasoningEngine.ts";
import { buildRevisionPrompt, verifyClaims } from "./claimVerifier.ts";
import { isArtifactRequest } from "./factRetrieval.ts";
import { extractResponseTags } from "./turnKind.ts";

/**
 * Verify-and-revise for Business Assistance -- PILOT GUARDRAIL (Finding #005).
 *
 * This is a pilot mitigation, not the fix for claim fidelity. It removes one
 * class of problem (figures and business-value language that no retrieved
 * source contains). It does NOT address scope or causality strengthening (a
 * comparison restated as a cause, one offer's claim stated as general, a
 * population or region qualifier dropped): Finding #005 stays open for those.
 * See docs/pilot-claim-verifier.md.
 *
 * The claim-fidelity rule in the system prompt is only partly followed, so
 * this adds a deterministic safety net: after the model answers a Business
 * Assistance turn, the draft is checked against the retrieved chunks for
 * figures and business-value language that no source contains. Only if that
 * check finds something, ONE revision call asks the model to remove exactly
 * those items. The revision is kept only if it has fewer violations than the
 * draft; otherwise the original draft stands. Clean drafts, and every turn
 * that is not Business Assistance, cost no extra call.
 *
 * Trade-off that cannot be avoided: a draft can only be checked once it is
 * complete, so on turns that may be artifact requests the answer is buffered
 * instead of streamed token by token.
 *
 * On by default for the pilot; HUBI_VERIFY_CLAIMS=0 turns it off.
 */

/** The pilot setting. Flip this (or set HUBI_VERIFY_CLAIMS=0) to run without the guardrail. */
export const CLAIM_VERIFIER_PILOT_DEFAULT = true;

export interface VerificationInfo {
  /** The turn was buffered and verification was possible (verification enabled and the turn predicted as an artifact request). */
  buffered: boolean;
  /** The draft was scanned (the model reported business-assistance). */
  checked: boolean;
  violationsBefore: number;
  violationsAfter: number;
  /** A revision call was made. */
  revised: boolean;
  /** The revision replaced the draft. */
  revisionAccepted: boolean;
  /** Flagged phrases in the first draft. */
  phrases: string[];
  /** Milliseconds spent on the revision call. */
  extraMs: number;
  /** The first draft, kept only when a revision was attempted, so a reviewer can see exactly what was changed. */
  draft?: string;
}

export interface GeneratedTurn {
  response: ReasoningResult;
  verification: VerificationInfo;
}

const NOT_VERIFIED: VerificationInfo = {
  buffered: false,
  checked: false,
  violationsBefore: 0,
  violationsAfter: 0,
  revised: false,
  revisionAccepted: false,
  phrases: [],
  extraMs: 0,
};

/** Whether verification is enabled: the pilot default, overridden by HUBI_VERIFY_CLAIMS=1 or =0. */
export function verificationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.HUBI_VERIFY_CLAIMS?.trim();
  if (flag === "0") return false;
  if (flag === "1") return true;
  return CLAIM_VERIFIER_PILOT_DEFAULT;
}

/** Whether this turn should be buffered and verified: enabled, and predicted to be an artifact request. */
export function shouldVerify(question: string, lastPlanningMode: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return verificationEnabled(env) && isArtifactRequest(question, lastPlanningMode);
}

// A revision that is much shorter than the draft has probably been cut off or has dropped the artifact.
const MIN_REVISION_RATIO = 0.4;

export async function generateWithVerification(options: {
  engine: ReasoningEngine;
  prompt: string;
  systemPrompt: string;
  /** Texts of the chunks the model was given: the only support a claim can have. */
  retrievedTexts: string[];
  verify: boolean;
  /** Streaming callback; used only when `verify` is false. */
  onDelta?: (text: string) => void;
}): Promise<GeneratedTurn> {
  const { engine, prompt, systemPrompt, retrievedTexts } = options;

  if (!options.verify) {
    const response = await engine(prompt, systemPrompt, { onDelta: options.onDelta });
    return { response, verification: NOT_VERIFIED };
  }

  const draft = await engine(prompt, systemPrompt);
  const base: VerificationInfo = { ...NOT_VERIFIED, buffered: true };
  if (!draft.ok) return { response: draft, verification: base };

  const draftTags = extractResponseTags(draft.text);
  if (draftTags.planningMode !== "business-assistance") return { response: draft, verification: base };

  const before = verifyClaims(draftTags.text, retrievedTexts);
  const checked: VerificationInfo = { ...base, checked: true, violationsBefore: before.violations.length, violationsAfter: before.violations.length, phrases: before.phrases };
  if (before.violations.length === 0) return { response: draft, verification: checked };

  const start = performance.now();
  const revision = await engine(buildRevisionPrompt(prompt, draftTags.text, before), systemPrompt);
  const extraMs = performance.now() - start;
  const revised: VerificationInfo = { ...checked, revised: true, extraMs, draft: draftTags.text };
  if (!revision.ok) return { response: draft, verification: revised };

  const revisedTags = extractResponseTags(revision.text);
  const after = verifyClaims(revisedTags.text, retrievedTexts);
  revised.violationsAfter = after.violations.length;

  const intact = revisedTags.text.length >= draftTags.text.length * MIN_REVISION_RATIO;
  if (after.violations.length < before.violations.length && intact) {
    return {
      response: { ...revision, durationMs: draft.durationMs + revision.durationMs },
      verification: { ...revised, revisionAccepted: true },
    };
  }
  revised.violationsAfter = before.violations.length;
  return { response: draft, verification: revised };
}
