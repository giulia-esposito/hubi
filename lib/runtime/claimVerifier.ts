/**
 * Deterministic claim verification for generated artifacts (Finding #005).
 *
 * The generation rule ("restate claims at the same strength and scope the
 * source supports, or omit them") is a prompt instruction, and measurements on
 * Gemini 2.5 Flash show it is followed only part of the time. This module is
 * the checkable half: it finds the two kinds of unsupported content that can
 * be detected with no model at all --
 *
 *   figures        a percentage, multiplier or currency amount whose number
 *                  appears in no retrieved chunk
 *   value language ROI, productivity, retention, savings and similar
 *                  business-value terms that appear in no retrieved chunk
 *
 * and builds the instruction for a single revision call (see
 * verifiedGeneration.ts). It is general: nothing here names a product, a
 * region, an industry or an artifact type.
 *
 * Limits, stated plainly: a term the sources do use is never flagged here even
 * when it is restated with more strength or scope than the source gives it
 * (comparison turned into cause, one offer's claim made general). Those
 * fidelity failures need a model or a human; this only catches content that
 * has no support anywhere in the retrieved knowledge.
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
 * Return-on-investment, savings, productivity and similar value language.
 * Value claims are factual claims about what a product delivers, so each one
 * must exist in the retrieved knowledge.
 */
export const VALUE_LANGUAGE =
  /\b(roi|return on investment|cost[- ]sav\w*|sav(?:e|es|ing|ings) (?:you |your )?(?:money|costs?)|payback|value for (?:your )?(?:money|investment|spend)|maximi[sz]e (?:your |the )?(?:investment|spend|value|impact)|productiv\w*|retention|retain\w*|turnover|absenteeism|healthcare costs?|measurable (?:results|impact|outcomes?)|bottom line)\b/gi;

/**
 * Unsupported ROI / value language: any value term in the output that does
 * not occur in at least one retrieved chunk. A term that the sources
 * themselves use is not flagged here.
 */
export function checkUnsupportedValueLanguage(text: string, retrievedTexts: string[]): CheckResult {
  const retrieved = retrievedTexts.join("\n").toLowerCase();
  const violations: string[] = [];
  let claimPresent = false;
  for (const sentence of splitSentences(text)) {
    // A question that mentions a value term ("How do you measure ROI?") asks about
    // the client's situation; it is not a claim about what a product delivers.
    if (/\?["')\]*_]*$/.test(sentence)) continue;
    const matches = sentence.match(VALUE_LANGUAGE);
    if (!matches) continue;
    claimPresent = true;
    for (const term of new Set(matches.map((m) => m.toLowerCase()))) {
      if (!retrieved.includes(term)) violations.push(`value language not in retrieved knowledge ("${term}"): "${sentence}"`);
    }
  }
  return { claimPresent, violations };
}

/**
 * Figures: percentages, multipliers ("2.5x", "3 times"), currency amounts.
 * Written as a pattern, not as a list of known numbers, so it applies to any
 * output and any corpus.
 */
const FIGURE = /(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|×|times\b))/gi;

function figureCore(figure: string): string {
  return figure.replace(/[^\d.]/g, "").replace(/\.$/, "");
}

/**
 * Invented statistics: any figure in the output whose number does not appear
 * in at least one retrieved chunk. A figure the sources do state is not
 * flagged here (its scope and strength are a separate question).
 */
export function checkUngroundedFigures(text: string, retrievedTexts: string[]): CheckResult {
  const retrieved = retrievedTexts.join("\n");
  const violations: string[] = [];
  let claimPresent = false;
  for (const sentence of splitSentences(text)) {
    const matches = sentence.match(FIGURE);
    if (!matches) continue;
    claimPresent = true;
    for (const figure of new Set(matches)) {
      const core = figureCore(figure);
      if (core && !retrieved.includes(core)) violations.push(`figure not in retrieved knowledge ("${figure.trim()}"): "${sentence}"`);
    }
  }
  return { claimPresent, violations };
}

export interface ClaimVerification {
  /** One entry per offending phrase, with its sentence, ready to show a reviewer or a reviser. */
  violations: string[];
  /** Just the offending phrases (figures and value terms). */
  phrases: string[];
}

/** Runs both checks against the retrieved chunk texts. */
export function verifyClaims(text: string, retrievedTexts: string[]): ClaimVerification {
  const figures = checkUngroundedFigures(text, retrievedTexts).violations;
  const value = checkUnsupportedValueLanguage(text, retrievedTexts).violations;
  const violations = [...figures, ...value];
  const phrases = violations.map((v) => v.match(/\("([^"]+)"\)/)?.[1] ?? v);
  return { violations, phrases };
}

/**
 * The follow-up prompt for the single revision call: the original prompt
 * (system prompt is sent separately by the caller), the flagged claims, and
 * the draft to correct. The response format is restated because the revised
 * text goes through the same tag parsing as any other response.
 */
export function buildRevisionPrompt(originalPrompt: string, draftText: string, verification: ClaimVerification): string {
  const flagged = verification.violations.map((v) => `- ${v}`).join("\n");
  return (
    `${originalPrompt}\n\n` +
    `[Revision required -- claim check]\n` +
    `A deterministic check compared your previous draft with the Retrieved Knowledge above and found content that no retrieved source supports:\n${flagged}\n\n` +
    `Rewrite the response so that every flagged item is removed, or restated only as far as a source supports. ` +
    `Keep everything else: the structure, the tone and every supported fact. Do not add new claims, figures or benefits. ` +
    `Keep the required response format: the planning-mode tag on the first line and the turn-kind tag on the last line.\n\n` +
    `Previous draft:\n<<<\n${draftText}\n>>>`
  );
}
