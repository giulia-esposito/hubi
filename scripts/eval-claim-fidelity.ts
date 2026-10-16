/**
 * Claim-fidelity regression baseline for Finding #005
 * (docs/validation-findings.md): scoped source claims restated with less
 * scope, less qualification or more strength than the source gives them.
 *
 * MEASUREMENT ONLY. This script reports the current behavior; it changes
 * nothing, and failures are expected until a generation rule is tested. It
 * always exits 0 unless the harness itself breaks. It is not part of
 * `npm test` (it calls a live provider).
 *
 * Fixtures are synthetic. They reproduce the *shape* of the real Finding #005
 * evidence (a product-scoped speaker-note claim, region-specific figures, a
 * population-qualified figure, a with/without comparison) using neutral
 * invented content, so the checks and the report are about the failure class,
 * not about one product, region or industry. Retrieval is the real BM25
 * index; a run is marked INVALID if the chunk the scenario depends on was not
 * retrieved, so a retrieval miss can never masquerade as a model result.
 *
 * Failure classes reported separately:
 *   applicability -- a claim scoped to a product/offer or region is used in a
 *                    request that does not establish that scope, and is
 *                    stated without the scope.
 *   fidelity      -- the request establishes (or does not need) the scope, but
 *                    the restatement drops a qualifier or strengthens the
 *                    claim (population, comparison -> causation).
 *   grounding     -- value/ROI language that no retrieved chunk contains.
 * Each applicability scenario has a "-control" twin whose request DOES state
 * the scope. If the control passes where the base scenario fails, the cause is
 * applicability; if both fail, it is claim fidelity.
 *
 *   GOOGLE_CLOUD_PROJECT=<project> HUBI_REASONING_PROVIDER=gemini \
 *   EVAL_RUNS=5 node --experimental-strip-types scripts/eval-claim-fidelity.ts [scenario-id]
 */
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { buildIndex, search } from "../lib/retrieval/index.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { getReasoningEngine, resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { extractResponseTags } from "../lib/runtime/turnKind.ts";
import type { Turn } from "../lib/runtime/sessionState.ts";
import {
  checkFigureQualifiers,
  checkNoCausalStrengthening,
  checkScope,
  comparisonClaimTrigger,
  checkUnsupportedValueLanguage,
  type CheckResult,
  type QualifierWindow,
} from "./lib/claimFidelityChecks.ts";

function chunk(id: string, documentTitle: string, heading: string, text: string): Chunk {
  return { id, documentId: id, documentTitle, heading, text, citationUrl: null, citationUrlType: null };
}

// --- Synthetic fixtures (invented content; see header) ---

const BASE = chunk(
  "base",
  "Wellhub Pitch Guide",
  "Core pitch message",
  "Wellhub pitch: Wellhub gives employees one subscription to many gyms, studios and wellbeing apps. The core pitch message is engagement: people use benefits they actually enjoy."
);

const SCOPED_PRODUCT = chunk(
  "scoped-product",
  "Slide Library",
  "Slide 12: Smart Reminders add-on pitch",
  "Smart Reminders add-on pitch. Speaker notes: Companies that turn on Smart Reminders see the highest engagement rates, and that boosts your ROI. Smart Reminders sends employees short, personal prompts."
);

const REGION_US = chunk(
  "region-us",
  "Slide Library",
  "Slide 20: Wellness Challenges participation (US)",
  "Wellness Challenges participation rate. Companies with Wellness Challenges enabled: 2.5x. Region: US. Source: Wellhub comparative analysis of average participation rates with and without Wellness Challenges, 2023."
);

const REGION_GLOBAL = chunk(
  "region-global",
  "Slide Library",
  "Slide 21: Wellness Challenges participation (Global)",
  "Wellness Challenges participation rate. Companies with Wellness Challenges enabled: 1.7x. Region: Global. Source: Wellhub comparative analysis of average participation rates with and without Wellness Challenges, 2023."
);

const POPULATION = chunk(
  "population",
  "Slide Library",
  "Slide 30: Wellness Challenges and monthly activity",
  "Among accounts with 500+ employees, companies with Wellness Challenges enabled had a 40% higher monthly active rate than companies without, in a 2023 analysis of 120 accounts."
);

// Harder population fixture: the figure is prominent and the population /
// sample qualifier sits in a footnote, as on the real slides ("Sources: ...
// Based on accounts with 500+ employees"). Nothing in the figure sentence
// itself hints that the figure only describes a sub-population.
const POPULATION_FOOTNOTE = chunk(
  "population-footnote",
  "Slide Library",
  "Slide 31: Wellness Challenges and monthly activity",
  "Wellness Challenges and monthly activity. Companies with Wellness Challenges enabled: 40% higher monthly active rate than companies without. Source: Wellhub comparative analysis, 2023. Note: based on accounts with 500+ employees, n = 120 accounts."
);

const COMPARISON = chunk(
  "comparison",
  "Slide Library",
  "Slide 40: Wellness Challenges and member retention",
  "Companies with Wellness Challenges enabled show 1.4x higher member retention than companies without (comparative analysis of existing accounts, 2023)."
);

const FEATURE = chunk(
  "feature",
  "Wellhub Feature Overview",
  "Wellness Challenges",
  "Wellness Challenges are team competitions that employees join through the app. Challenges run for a set number of weeks."
);

// --- Scenario definitions ---

type FailureClass = "applicability" | "fidelity" | "grounding";

interface Scenario {
  id: string;
  /** What this scenario measures, in general terms. */
  measures: string;
  failureClass: FailureClass;
  question: string;
  fixtures: Chunk[];
  /** Chunk ids that must be retrieved for the run to be a valid measurement. */
  mustRetrieve: string[];
  /** Earlier turns, for follow-up scenarios (e.g. tailoring an artifact to an audience). */
  history?: Turn[];
  /** Retrieval text when it differs from the question (accumulated user messages). */
  retrievalQuery?: string;
  /**
   * Runs the scenario's own assertion; the universal value-language check
   * always runs too. `window` is how near the claim a qualifier must be:
   * "sentence" (strict) or "adjacent" (pronoun-tolerant); both are measured.
   */
  assert: (text: string, window: QualifierWindow) => CheckResult;
}

const ELEVATOR = "Write me an elevator pitch for Wellhub.";
const CHALLENGE_PITCH = "Write a short pitch for a prospect that highlights Wellness Challenges.";

// 1. Product / offer scope: a claim that belongs to one add-on must not be
//    stated as if it were a property of the whole product.
const productScope = (text: string, window: QualifierWindow) =>
  checkScope(text, /highest engagement|roi|return on investment/i, /smart reminders|reminders|add-on/i, "product/offer scope", window);

// 2. Region: each figure must travel with the region it was measured in.
const regionScope = (text: string, window: QualifierWindow) =>
  checkFigureQualifiers(
    text,
    [
      { figure: /2\.5\s?(x|times|×)/i, qualifier: /\bus\b|u\.s\.|united states|american/i, what: "region (US)" },
      { figure: /1\.7\s?(x|times|×)/i, qualifier: /global|worldwide|internationally|across regions/i, what: "region (Global)" },
    ],
    window
  );

// 3. Population / sample: a figure measured on a sub-population must say so.
const populationScope = (text: string, window: QualifierWindow) =>
  checkScope(
    text,
    /40\s?%/,
    /500\+|500 or more|more than 500|over 500|large(r)? (companies|organi[sz]ations|accounts)|enterprise|120 accounts|accounts with/i,
    "population/sample qualifier",
    window
  );

// 4. Comparison vs. causality: a with/without comparison must not become a
//    causal or conclusive claim. (Not a qualifier-distance check, so `window`
//    does not apply.)
const comparisonNotCausal = (text: string) =>
  checkNoCausalStrengthening(text, comparisonClaimTrigger(/1\.4\s?(x|times|×)/i, "retention"));

const SCENARIOS: Scenario[] = [
  {
    id: "scope-product",
    measures: "product/offer scope preservation (request does not establish the add-on)",
    failureClass: "applicability",
    question: ELEVATOR,
    fixtures: [BASE, SCOPED_PRODUCT],
    mustRetrieve: ["scoped-product"],
    assert: productScope,
  },
  {
    id: "scope-product-control",
    measures: "same assertion, request states the add-on (isolates claim fidelity)",
    failureClass: "fidelity",
    question: "Write me an elevator pitch for the Smart Reminders add-on.",
    fixtures: [BASE, SCOPED_PRODUCT],
    mustRetrieve: ["scoped-product"],
    assert: productScope,
  },
  {
    id: "scope-region",
    measures: "region preservation (request does not state a region)",
    failureClass: "applicability",
    question: CHALLENGE_PITCH,
    fixtures: [BASE, REGION_US, REGION_GLOBAL],
    mustRetrieve: ["region-us", "region-global"],
    assert: regionScope,
  },
  {
    id: "scope-region-control",
    measures: "same assertion, request states the region (isolates claim fidelity)",
    failureClass: "fidelity",
    question: "Write a short pitch for a prospect in the US that highlights Wellness Challenges.",
    fixtures: [BASE, REGION_US, REGION_GLOBAL],
    mustRetrieve: ["region-us", "region-global"],
    assert: regionScope,
  },
  {
    id: "scope-population",
    measures: "population / sample qualifier preservation",
    failureClass: "fidelity",
    question: CHALLENGE_PITCH,
    fixtures: [BASE, POPULATION],
    mustRetrieve: ["population"],
    assert: populationScope,
  },
  {
    id: "scope-population-footnote",
    measures: "population / sample qualifier preservation when the qualifier sits in a footnote (harder fixture)",
    failureClass: "fidelity",
    question: CHALLENGE_PITCH,
    fixtures: [BASE, POPULATION_FOOTNOTE],
    mustRetrieve: ["population-footnote"],
    assert: populationScope,
  },
  {
    id: "scope-population-footnote-mismatch",
    measures: "same fixture, request names a prospect far outside the measured population (omit it or qualify it)",
    failureClass: "applicability",
    question: "Write a short pitch for a prospect with 60 employees that highlights Wellness Challenges.",
    fixtures: [BASE, POPULATION_FOOTNOTE],
    mustRetrieve: ["population-footnote"],
    assert: populationScope,
  },
  {
    id: "comparison-vs-causality",
    measures: "comparison vs. causality preservation",
    failureClass: "fidelity",
    question: CHALLENGE_PITCH,
    fixtures: [BASE, COMPARISON],
    mustRetrieve: ["comparison"],
    assert: comparisonNotCausal,
  },
  {
    id: "unsupported-value-language",
    measures: "ROI / value language that no retrieved chunk supports",
    failureClass: "grounding",
    question: ELEVATOR,
    fixtures: [BASE, FEATURE],
    mustRetrieve: ["base"],
    // Everything is measured by the universal value-language check; this
    // scenario has no scope assertion of its own.
    assert: () => ({ claimPresent: false, violations: [] }),
  },
  {
    // The plain request above did not trigger unsupported value language in the
    // first baseline run. In the real Finding #005 evidence it appeared when an
    // artifact was TAILORED to an audience, so the same measurement is repeated
    // on a follow-up that supplies an industry and size.
    id: "unsupported-value-language-tailoring",
    measures: "ROI / value language added when an artifact is tailored to an audience (follow-up turn)",
    failureClass: "grounding",
    question: "A mid-size company in the retail industry.",
    history: [
      { role: "user", content: ELEVATOR },
      {
        role: "assistant",
        content:
          "Here is a pitch: Wellhub gives your employees one subscription to many gyms, studios and wellbeing apps. Our core message is engagement: people use benefits they actually enjoy.",
      },
    ],
    retrievalQuery: `${ELEVATOR} A mid-size company in the retail industry.`,
    fixtures: [BASE, FEATURE],
    mustRetrieve: ["base"],
    assert: () => ({ claimPresent: false, violations: [] }),
  },
];

// --- Runner ---

type Outcome = "omitted" | "faithful" | "fail" | "invalid" | "engine-error";

interface RunResult {
  outcome: Outcome;
  /** Violations under the strict same-sentence standard. */
  violations: string[];
  /** Subset of `violations` that also fail when the previous sentence may carry the qualifier. */
  adjacentViolations: string[];
  valueViolations: string[];
  note?: string;
  text: string;
}

const RETRY_PATTERN = /429|RESOURCE_EXHAUSTED|Resource exhausted/i;

async function askWithRetry(prompt: string) {
  const ask = getReasoningEngine();
  let last = await ask(prompt, HUBI_SYSTEM_PROMPT);
  for (let attempt = 1; attempt <= 2 && !last.ok && RETRY_PATTERN.test(String(last.error)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 8000 * attempt));
    last = await ask(prompt, HUBI_SYSTEM_PROMPT);
  }
  return last;
}

async function runOnce(s: Scenario): Promise<RunResult> {
  const results = search(buildIndex(s.fixtures), s.retrievalQuery ?? s.question, 5);
  const retrievedIds = new Set(results.map((r) => r.chunk.id));
  const missing = s.mustRetrieve.filter((id) => !retrievedIds.has(id));
  if (missing.length) {
    return { outcome: "invalid", violations: [], adjacentViolations: [], valueViolations: [], note: `not retrieved: ${missing.join(", ")}`, text: "" };
  }

  const response = await askWithRetry(buildPrompt(s.question, results, s.history ?? []));
  if (!response.ok) {
    return { outcome: "engine-error", violations: [], adjacentViolations: [], valueViolations: [], note: String(response.error).slice(0, 120), text: "" };
  }

  const { text } = extractResponseTags(response.text);
  const scoped = s.assert(text, "sentence");
  const tolerant = s.assert(text, "adjacent");
  const value = checkUnsupportedValueLanguage(text, results.map((r) => r.chunk.text));
  const failed = scoped.violations.length > 0 || value.violations.length > 0;
  const outcome: Outcome = failed ? "fail" : scoped.claimPresent ? "faithful" : "omitted";
  return { outcome, violations: scoped.violations, adjacentViolations: tolerant.violations, valueViolations: value.violations, text };
}

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  console.log(`Claim-fidelity baseline (Finding #005) -- provider: ${resolveReasoningProvider()}, runs per scenario: ${runs}`);
  console.log("MEASUREMENT ONLY: failures are expected and do not change the exit code.\n");

  const summary: string[] = [];

  for (const s of scenarios) {
    console.log(`=== ${s.id} [${s.failureClass}] -- ${s.measures}`);
    console.log(`    request: ${s.question}`);
    const counts: Record<Outcome, number> = { omitted: 0, faithful: 0, fail: 0, invalid: 0, "engine-error": 0 };
    let scopeFails = 0;
    let adjacentFails = 0;
    let valueFails = 0;

    for (let i = 0; i < runs; i++) {
      const r = await runOnce(s);
      counts[r.outcome]++;
      if (r.violations.length) scopeFails++;
      if (r.adjacentViolations.length) adjacentFails++;
      if (r.valueViolations.length) valueFails++;
      console.log(`--- run ${i + 1}: ${r.outcome.toUpperCase()}${r.note ? ` (${r.note})` : ""}`);
      for (const v of r.violations) {
        const tag = r.adjacentViolations.includes(v) ? "" : " (strict-only: the previous sentence carries the qualifier)";
        console.log(`    x [${s.failureClass}]${tag} ${v}`);
      }
      for (const v of r.valueViolations) console.log(`    x [grounding] ${v}`);
      if (r.text) console.log(r.text.split("\n").map((l) => `    | ${l}`).join("\n"));
    }

    const valid = runs - counts.invalid - counts["engine-error"];
    summary.push(
      `${s.id.padEnd(36)} ${s.failureClass.padEnd(13)} valid ${valid}/${runs} | claim omitted ${counts.omitted} | faithful ${counts.faithful} | ` +
        `violations strict ${scopeFails} / adjacent-tolerant ${adjacentFails} | unsupported value language ${valueFails}` +
        (counts.invalid ? ` | INVALID ${counts.invalid}` : "") +
        (counts["engine-error"] ? ` | ENGINE ERRORS ${counts["engine-error"]}` : "")
    );
    console.log("");
  }

  console.log("=== SUMMARY (omitted = faithful by omission; strict = qualifier must be in the same sentence, adjacent-tolerant = same or previous sentence, so adjacent <= strict)");
  for (const line of summary) console.log(line);
}

main();
