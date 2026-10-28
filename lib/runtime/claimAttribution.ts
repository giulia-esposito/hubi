/**
 * Claim attribution and fidelity checks (Finding #005, toward closing it).
 *
 * claimVerifier.ts catches content that has no support anywhere (figures and
 * value language absent from every source). It cannot see a claim that IS in a
 * source but is restated with more strength or less scope. This module makes
 * that checkable: for a Business Assistance answer the model also returns a
 * claims ledger, a list of the factual claims it used, each with the source it
 * relies on and the exact words it quotes from that source. The ledger is
 * hidden from the user and verified deterministically:
 *
 *   quote        the quote must appear verbatim in the cited source
 *   figures      every figure in the claim must be in the quote
 *   strength     causal / conclusive wording in the claim must be in the quote
 *                (a comparison must not become a cause)
 *   qualifiers   region, population, sample size, comparison and numeric hedges
 *                ("up to", "average") that the source states next to the quote,
 *                or in its note or source line, must be kept in the claim
 *   coverage     every figure in the artifact must be backed by a ledger claim
 *
 * General by construction: the qualifier classes are patterns, the region
 * names come from the approved vocabulary, and nothing names a product, an
 * offer, an industry or an artifact type. A model that returns no ledger is
 * reported as "missing", not penalized.
 *
 * Limits, stated plainly: it cannot tell whether a quote truly supports a
 * claim's meaning, only that the claim keeps the strength and qualifiers the
 * quoted source states; and a claim the model leaves out of the ledger is
 * caught only when it contains a figure.
 */
import { getRegionVocabulary } from "../applicability/regions.ts";
import { CAUSAL_STRENGTHENING, splitSentences } from "./claimVerifier.ts";

export const CLAIMS_OPEN = "[[HUBI:CLAIMS]]";
export const CLAIMS_CLOSE = "[[/HUBI:CLAIMS]]";

export interface LedgerClaim {
  claim: string;
  /** 1-based number of the [Source n] the claim relies on. */
  source: number;
  quote: string;
}

export type LedgerStatus = "ok" | "missing" | "malformed";

export interface ExtractedLedger {
  /** The response with the ledger block removed. */
  text: string;
  status: LedgerStatus;
  claims: LedgerClaim[];
}

const BLOCK = new RegExp(`${escapeRegExp(CLAIMS_OPEN)}([\\s\\S]*?)${escapeRegExp(CLAIMS_CLOSE)}`);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes the ledger block (if any) from a response; never throws. */
export function stripClaimsBlock(raw: string): string {
  return raw.replace(BLOCK, "").replace(/\n{3,}/g, "\n\n");
}

/** Parses the ledger out of a raw response. A missing or unparseable block yields no claims, never an error. */
export function extractLedger(raw: string): ExtractedLedger {
  const match = raw.match(BLOCK);
  const text = stripClaimsBlock(raw);
  if (!match) return { text, status: "missing", claims: [] };
  try {
    const body = match[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) return { text, status: "malformed", claims: [] };
    const claims: LedgerClaim[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const { claim, source, quote } = item as Record<string, unknown>;
      const n = typeof source === "number" ? source : Number(source);
      if (typeof claim === "string" && typeof quote === "string" && Number.isInteger(n) && claim.trim()) {
        claims.push({ claim: claim.trim(), source: n, quote: quote.trim() });
      }
    }
    return { text, status: "ok", claims };
  } catch {
    return { text, status: "malformed", claims: [] };
  }
}

export type AttributionIssue =
  | "bad-source"
  | "quote-not-found"
  | "figure-not-in-quote"
  | "causal-strengthening"
  | "dropped-qualifier"
  | "figure-unattributed";

export interface AttributionViolation {
  type: AttributionIssue;
  message: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** A quote may use "..." to skip text; every fragment must appear, in order. */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const text = norm(source);
  const fragments = quote.split(/\.{3}|…/).map(norm).filter((f) => f.length >= 8);
  if (fragments.length === 0) return false;
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }
  return true;
}

const FIGURE = /(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|×|times\b))/gi;
const figureCore = (f: string) => f.replace(/[^\d.]/g, "").replace(/\.$/, "");
const figuresIn = (text: string) => [...new Set((text.match(FIGURE) ?? []).map(figureCore).filter(Boolean))];

type QualifierClass = "region" | "population" | "sample" | "comparison" | "hedge";

interface QualifierMatch {
  cls: QualifierClass;
  text: string;
  /** For a hedge: the figure it modifies, so it only counts against a claim that states that figure. */
  figure?: string;
}

const POPULATION = /\b\d[\d,]*\+?\s*(?:employees|accounts|companies|clients|customers|users|members|subscribers|people|respondents|participants)\b|\b(?:enterprise|smb|mid-?size(?:d)?|small|large)\b/gi;
const SAMPLE = /\bn\s*=\s*\d+|\bsample of\b|\bstudy of\b|\bsurvey(?:ed)?\b/gi;
const COMPARISON = /\b(?:than|compared (?:to|with)|versus|vs\.?|relative to|with and without|non-users|without)\b/gi;
const HEDGE = /\b(?:up to|on average|averag\w*|approximately|about|around|roughly|at least|as much as)\b(?=\s+(?:\w+\s+){0,2}\$?\d)/gi;

function regionPatterns(): RegExp[] {
  const vocabulary = getRegionVocabulary();
  const names = new Set<string>();
  for (const r of vocabulary.regions) for (const a of [r.name, ...r.aliases]) names.add(a);
  for (const c of vocabulary.countries) for (const a of [c.name, ...c.aliases]) names.add(a);
  const patterns: RegExp[] = [];
  for (const name of names) {
    // Short all-caps names (US, UK, BR) are case-sensitive: "us" is a pronoun.
    const sensitive = name.length <= 4 && name === name.toUpperCase();
    patterns.push(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, sensitive ? "u" : "iu"));
  }
  return patterns;
}

const REGION_ADVERBS = /\b(?:globally|worldwide|globalmente|mundialmente|global)\b/i;

function collect(text: string): QualifierMatch[] {
  const found: QualifierMatch[] = [];
  const add = (cls: QualifierClass, re: RegExp) => {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) found.push({ cls, text: m[0] });
  };
  add("population", POPULATION);
  add("sample", SAMPLE);
  add("comparison", COMPARISON);
  for (const m of text.matchAll(new RegExp(HEDGE.source, "gi"))) {
    const following = text.slice((m.index ?? 0) + m[0].length).match(FIGURE);
    found.push({ cls: "hedge", text: m[0], figure: following ? figureCore(following[0]) : undefined });
  }
  for (const re of regionPatterns()) {
    const m = text.match(re);
    if (m) found.push({ cls: "region", text: m[0] });
  }
  const adverb = text.match(REGION_ADVERBS);
  if (adverb) found.push({ cls: "region", text: adverb[0] });
  return found;
}

const FOOTNOTE_LINE = /^\s*(?:note|notes|source|sources|based on|footnote|\*)\b/i;

/**
 * What the source says around the quote that qualifies it: the line holding the
 * quote plus any note or source line of the same chunk (slides carry the
 * population, region and sample in a footnote).
 */
export function qualifyingContext(chunkText: string, quote: string): { holding: string; wide: string } {
  const lines = chunkText.split(/\n+/);
  const holding = lines.filter((l) => quoteAppearsIn(quote, l));
  const foot = lines.filter((l) => FOOTNOTE_LINE.test(l));
  const wide = [...holding, ...foot];
  return { holding: holding.join("\n"), wide: (wide.length > 0 ? wide : [chunkText]).join("\n") };
}

const CLASS_LABEL: Record<QualifierClass, string> = {
  region: "region",
  population: "population or size",
  sample: "sample",
  comparison: "comparison basis",
  hedge: "hedge (\"up to\", \"average\")",
};

/**
 * Verifies the ledger against the artifact and the sources the model was
 * given. `sources[i]` is the text of [Source i+1].
 */
export function verifyAttribution(artifact: string, claims: LedgerClaim[], sources: string[]): AttributionViolation[] {
  const violations: AttributionViolation[] = [];

  for (const c of claims) {
    const chunk = sources[c.source - 1];
    if (chunk === undefined) {
      violations.push({ type: "bad-source", message: `claim cites Source ${c.source}, which does not exist: "${c.claim}"` });
      continue;
    }
    if (!quoteAppearsIn(c.quote, chunk)) {
      violations.push({ type: "quote-not-found", message: `the quote is not verbatim in Source ${c.source}: "${c.quote}" (claim: "${c.claim}")` });
      continue;
    }

    const quoteFigures = figuresIn(c.quote);
    for (const figure of figuresIn(c.claim)) {
      if (!quoteFigures.includes(figure)) {
        violations.push({ type: "figure-not-in-quote", message: `"${figure}" is in the claim but not in its quote (claim: "${c.claim}")` });
      }
    }

    const claimCausal = (c.claim.match(new RegExp(CAUSAL_STRENGTHENING.source, "gi")) ?? []).map((w) => w.toLowerCase());
    const quoteLower = c.quote.toLowerCase();
    const strengthened = [...new Set(claimCausal)].filter((w) => !quoteLower.includes(w));
    if (strengthened.length > 0) {
      violations.push({
        type: "causal-strengthening",
        message: `the claim says "${strengthened.join('", "')}" but the source words do not (source: "${c.quote}"; claim: "${c.claim}")`,
      });
    }

    const context = qualifyingContext(chunk, c.quote);
    const inClaim = new Set(collect(c.claim).map((q) => q.cls));
    const claimFigures = figuresIn(c.claim);
    const reported = new Set<QualifierClass>();
    // Region, population and sample may sit in a footnote; a hedge or comparison qualifies only
    // the sentence that holds the quote, and a hedge only the figure it precedes.
    const candidates = [
      ...collect(context.wide).filter((q) => q.cls === "region" || q.cls === "population" || q.cls === "sample"),
      ...collect(context.holding).filter((q) => q.cls === "hedge" || q.cls === "comparison"),
    ];
    for (const q of candidates) {
      if (reported.has(q.cls) || inClaim.has(q.cls)) continue;
      if (q.cls === "hedge" && (!q.figure || !claimFigures.includes(q.figure))) continue;
      if (q.cls === "comparison" && claimFigures.length === 0) continue;
      reported.add(q.cls);
      violations.push({
        type: "dropped-qualifier",
        message: `the claim drops the ${CLASS_LABEL[q.cls]} the source states ("${q.text}") (claim: "${c.claim}")`,
      });
    }
  }

  // Coverage: a figure in the artifact must be backed by a ledger claim that states it.
  const claimed = new Set(claims.flatMap((c) => figuresIn(c.claim)));
  for (const sentence of splitSentences(artifact)) {
    for (const figure of figuresIn(sentence)) {
      if (!claimed.has(figure)) violations.push({ type: "figure-unattributed", message: `"${figure}" appears in the answer with no ledger claim attributing it: "${sentence}"` });
    }
  }
  return violations;
}

/** The instruction appended to the prompt on turns that return a ledger. */
export const LEDGER_INSTRUCTION =
  `[Claims ledger -- required when your planning mode is BUSINESS_ASSISTANCE]\n` +
  `After the artifact and before the final tag, output a block in exactly this format (it is never shown to the user):\n` +
  `${CLAIMS_OPEN}\n` +
  `[{"claim": "<a factual claim exactly as you wrote it in the artifact>", "source": <number n of the [Source n] that supports it>, "quote": "<the exact words from that source that support it, copied verbatim>"}]\n` +
  `${CLAIMS_CLOSE}\n` +
  `List every factual claim about the product, the company, clients, figures, results or benefits that appears in the artifact. ` +
  `Copy each quote word for word from the cited source, keep the claim at the same strength and scope as the quote, and include in the claim the region, population, sample or comparison basis that the source states for it. ` +
  `If you cannot quote support for a claim, remove it from the artifact instead of listing it.`;
