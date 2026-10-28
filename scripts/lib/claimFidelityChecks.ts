/**
 * Deterministic claim-fidelity checks used by scripts/eval-claim-fidelity.ts
 * (Finding #005 baseline). They are written against the *class* of problem --
 * a source claim restated with less scope, less qualification or more
 * strength than the source gives it -- not against any one product, feature,
 * region or industry. Scenario configuration (which claim, which qualifier)
 * lives in the eval script; the logic here is generic.
 *
 * All checks work at sentence level: a qualifier must appear in the same
 * sentence as the claim it qualifies. That is deliberately strict, because a
 * rep may lift a single sentence into an email or a slide.
 *
 * Measurement only: only the shared helpers re-exported from lib/runtime/claimVerifier.ts are used by production.
 */

import { splitSentences, type CheckResult } from "../../lib/runtime/claimVerifier.ts";

// The generic checks that production also uses (unsupported figures, unsupported
// value language, sentence splitting) live in lib/runtime/claimVerifier.ts so the
// eval and the runtime verifier can never drift apart.
export {
  splitSentences,
  VALUE_LANGUAGE,
  checkUnsupportedValueLanguage,
  checkUngroundedFigures,
} from "../../lib/runtime/claimVerifier.ts";
export type { CheckResult } from "../../lib/runtime/claimVerifier.ts";

/**
 * How far from the claim a qualifier may sit.
 *   "sentence" -- strict: the same sentence (a rep may lift one sentence).
 *   "adjacent" -- pronoun-tolerant: the same sentence OR the sentence
 *                 immediately before it, so "Smart Reminders sends prompts.
 *                 It boosts your ROI." still counts as scoped. A violation
 *                 under "adjacent" is a violation under "sentence" too, so the
 *                 adjacent count is the conservative (certain) one.
 */
export type QualifierWindow = "sentence" | "adjacent";

/**
 * Scope / qualifier preservation. Every sentence that makes the claim
 * (matches `trigger`) must also carry the qualifier that scopes it (product
 * or offer, population, period...), within `window`. A text that never makes
 * the claim passes with claimPresent = false: omission is a faithful outcome.
 */
export function checkScope(
  text: string,
  trigger: RegExp,
  qualifier: RegExp,
  what: string,
  window: QualifierWindow = "sentence"
): CheckResult {
  const violations: string[] = [];
  let claimPresent = false;
  const sentences = splitSentences(text);
  sentences.forEach((sentence, i) => {
    if (!trigger.test(sentence)) return;
    claimPresent = true;
    const scoped = qualifier.test(sentence) || (window === "adjacent" && i > 0 && qualifier.test(sentences[i - 1]));
    if (!scoped) violations.push(`${what} missing: "${sentence}"`);
  });
  return { claimPresent, violations };
}

export interface FigureQualifier {
  /** Matches the figure as it may be written (e.g. /2\.5\s?x/). */
  figure: RegExp;
  /** The qualifier that must travel with that figure (region, population...). */
  qualifier: RegExp;
  /** Human label for reports, e.g. "region". */
  what: string;
}

/** Each figure must be stated together with its own qualifier, or not at all. */
export function checkFigureQualifiers(
  text: string,
  pairs: FigureQualifier[],
  window: QualifierWindow = "sentence"
): CheckResult {
  const violations: string[] = [];
  let claimPresent = false;
  for (const pair of pairs) {
    const result = checkScope(text, pair.figure, pair.qualifier, pair.what, window);
    claimPresent ||= result.claimPresent;
    violations.push(...result.violations);
  }
  return { claimPresent, violations };
}

/**
 * Words that turn a comparison ("companies with X show higher Y than those
 * without") into a causal or conclusive statement. Matching is deliberately
 * limited to strengthening vocabulary, not to every verb.
 */
export const CAUSAL_STRENGTHENING =
  /\b(prove[sdn]?|proven|proof|caus(e|es|ed|ing)|driv(e|es|en|ing)|boost(s|ed|ing)?|increas(e|es|ed|ing)|improv(e|es|ed|ing)|rais(e|es|ed|ing)|guarantee[sd]?|ensur(e|es|ed|ing)|lead(s|ing)? to|result(s|ed|ing)? in|because of|thanks to|significantly)\b/i;

/**
 * Builds the trigger that identifies a sentence stating a compared claim:
 * either the figure itself, or the comparative phrase for the metric
 * ("higher retention", "retention is higher"). The bare metric word is
 * deliberately NOT a trigger: "To further boost engagement and retention,
 * consider X" mentions the metric without restating the comparison, and
 * flagging it was a false positive in the first Finding #005 baseline.
 */
export function comparisonClaimTrigger(figure: RegExp, metric: string): RegExp {
  const comparative = "(?:higher|greater|more|better)\\s+(?:[a-z-]+\\s+)?" + metric;
  const predicative = metric + "\\s+(?:is|are|was|were)\\s+(?:\\d|higher|greater)";
  return new RegExp(`${figure.source}|\\b${comparative}\\b|\\b${predicative}`, "i");
}

/**
 * Comparison vs. causality. A sentence that states the compared claim
 * (matches `trigger`) must not use causal or conclusive vocabulary.
 */
export function checkNoCausalStrengthening(text: string, trigger: RegExp): CheckResult {
  const violations: string[] = [];
  let claimPresent = false;
  for (const sentence of splitSentences(text)) {
    if (!trigger.test(sentence)) continue;
    claimPresent = true;
    const causal = sentence.match(CAUSAL_STRENGTHENING);
    if (causal) violations.push(`comparison restated as causal ("${causal[0]}"): "${sentence}"`);
  }
  return { claimPresent, violations };
}

