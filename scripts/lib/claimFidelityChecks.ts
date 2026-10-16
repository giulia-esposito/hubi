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
 * Measurement only: nothing here is imported by production code.
 */

export interface CheckResult {
  /** True when the claim the check is looking for appears in the text. */
  claimPresent: boolean;
  /** One entry per offending sentence; empty means the claim (if any) was faithful. */
  violations: string[];
}

/** Splits generated copy into sentences; list items and line breaks also end a sentence. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

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

/**
 * Return-on-investment, savings, productivity and similar value language.
 * Value claims are factual claims about what a product delivers, so each one
 * must exist in the retrieved knowledge.
 */
export const VALUE_LANGUAGE =
  /\b(roi|return on investment|cost[- ]sav\w*|sav(?:e|es|ing|ings) (?:you |your )?(?:money|costs?)|payback|value for (?:your )?(?:money|investment|spend)|maximi[sz]e (?:your |the )?(?:investment|spend|value|impact)|productiv\w*|retention|retain\w*|turnover|absenteeism|healthcare costs?|measurable (?:results|impact|outcomes?)|bottom line)\b/gi;

/**
 * Unsupported ROI / value language: any value term in the output that does
 * not occur in at least one retrieved chunk. A term that the sources
 * themselves use is not flagged here (its *scope* is the job of checkScope).
 */
export function checkUnsupportedValueLanguage(text: string, retrievedTexts: string[]): CheckResult {
  const retrieved = retrievedTexts.join("\n").toLowerCase();
  const violations: string[] = [];
  let claimPresent = false;
  for (const sentence of splitSentences(text)) {
    const matches = sentence.match(VALUE_LANGUAGE);
    if (!matches) continue;
    claimPresent = true;
    for (const term of new Set(matches.map((m) => m.toLowerCase()))) {
      if (!retrieved.includes(term)) violations.push(`value language not in retrieved knowledge ("${term}"): "${sentence}"`);
    }
  }
  return { claimPresent, violations };
}
