/**
 * Does Hubi ask for context only when the context changes the answer?
 *
 * Live evaluation on the real corpus and the configured provider (calls a model;
 * not part of `npm test`). It measures both failure directions, because both
 * hurt: failing to ask where the answer differs gives a confident wrong answer,
 * and asking where it does not adds friction to every conversation.
 *
 * Four kinds of scenario, each tagged with the dimension it tests:
 *   must-ask       the answer differs by tier, segment, role or region and the
 *                  user has not said which. Good: Hubi asks, or answers for every
 *                  variant. Bad: it silently answers for one value.
 *   must-not-ask   the answer does not depend on context. Good: it answers. Bad: it asks.
 *   pre-supplied   the context is in the question. Good: it answers. Bad: it asks again.
 *   follow-through the user is asked, then supplies the context. Good: the second
 *                  turn answers. Bad: it asks again or stalls.
 *
 * A reply counts as "asked" when the model reports a clarifying question, or the
 * reply is short and ends in a question. For must-ask scenarios, a reply that
 * answers and names two or more values of the dimension counts as "answered for
 * every variant", which is an acceptable alternative to asking; naming exactly
 * one value counts as a silent pick, the failure this eval exists to find.
 *
 * Stage of the process is not measured: the local corpus has no documents that
 * differ by stage for the same question, so there is nothing to test it against.
 *
 *   GOOGLE_CLOUD_PROJECT=<project> HUBI_REASONING_PROVIDER=gemini \
 *   EVAL_RUNS=3 node --experimental-strip-types scripts/eval-context-asking.ts [scenario-id] [--json out.json]
 */
import { writeFileSync } from "node:fs";
import { resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { converse, loadCorpus, type TurnResult } from "./lib/liveConversation.ts";

type Kind = "must-ask" | "must-not-ask" | "pre-supplied" | "follow-through";
type Dimension = "tier" | "segment" | "role" | "region" | "none";

interface Scenario {
  id: string;
  kind: Kind;
  dimension: Dimension;
  turns: string[];
  /** The values of the dimension, as patterns, used to tell "answered for every variant" from "silently picked one". */
  values?: RegExp[];
}

const TIERS = [/\btier\s*0\b|\bT0\b/i, /\btier\s*1\b|\bT1\b/i, /\btier\s*2\b|\bT2\b/i, /\btier\s*3\b|\bT3\b/i, /\btier\s*4\b|\bT4\b/i];
const SEGMENTS = [/\bENT\b|enterprise/i, /\bSMB\b|small and medium|small business/i];
const ROLES = [/client success|\bCS\b/i, /\bsales\b(?! tools)/i];
const REGIONS = [/united states|\bUS\b|\bUSA\b/i, /SS[ -]?Latam|latin america|m[eé]xico|argentina|chile/i, /europe|\bUK\b|germany|spain|france/i, /brazil|brasil/i];

const SCENARIOS: Scenario[] = [
  // Answer differs by context, context not given.
  { id: "ask-tier-service-level", kind: "must-ask", dimension: "tier", turns: ["What service level does a client get?"], values: TIERS },
  { id: "ask-tier-contract", kind: "must-ask", dimension: "tier", turns: ["What are the contract differences I need to know for my client?"], values: TIERS },
  { id: "ask-tier-onboarding", kind: "must-ask", dimension: "tier", turns: ["What are the steps of the client onboarding process?"], values: TIERS },
  { id: "ask-segment-pps", kind: "must-ask", dimension: "segment", turns: ["What does the PPS+ proposal look like for my client?"], values: SEGMENTS },
  { id: "ask-segment-contract", kind: "must-ask", dimension: "segment", turns: ["How do I put together the contract and the order form?"], values: SEGMENTS },
  { id: "ask-role-coaching", kind: "must-ask", dimension: "role", turns: ["How should I run a Work the Deal coaching session?"], values: ROLES },
  { id: "ask-region-competition", kind: "must-ask", dimension: "region", turns: ["What should I know about competition law when I talk to a client?"], values: REGIONS },

  // Answer does not depend on context.
  { id: "no-ask-pps", kind: "must-not-ask", dimension: "none", turns: ["What is Per Subscriber (PPS) pricing?"] },
  { id: "no-ask-flat-fee", kind: "must-not-ask", dimension: "none", turns: ["What is the Flat Fee pricing model?"] },
  { id: "no-ask-cadences", kind: "must-not-ask", dimension: "none", turns: ["How do I create effective cadences in Salesloft?"] },
  { id: "no-ask-mandatory-training", kind: "must-not-ask", dimension: "none", turns: ["Which trainings are mandatory for the revenue team?"] },
  { id: "no-ask-referral", kind: "must-not-ask", dimension: "none", turns: ["How are referral deals handled for revenue credit?"] },
  { id: "no-ask-wellhubverse", kind: "must-not-ask", dimension: "none", turns: ["What is the Wellhubverse?"] },
  { id: "no-ask-gmail", kind: "must-not-ask", dimension: "none", turns: ["How do I connect Salesforce to Gmail and Google Drive?"] },
  { id: "no-ask-pitch", kind: "must-not-ask", dimension: "none", turns: ["Write me an elevator pitch."] },

  // Context is already in the question.
  { id: "given-tier-onboarding", kind: "pre-supplied", dimension: "tier", turns: ["What meetings do I have to do for onboarding a Tier 1 client in Mexico?"] },
  { id: "given-tier-service-level", kind: "pre-supplied", dimension: "tier", turns: ["What service level does a Tier 2 client get?"] },
  { id: "given-segment-pps", kind: "pre-supplied", dimension: "segment", turns: ["For an Enterprise client, what does the PPS+ proposal look like?"] },
  { id: "given-region-competition", kind: "pre-supplied", dimension: "region", turns: ["I'm in the US. What should I know about competition law when I talk to a client?"] },

  // Asked, then the user answers.
  { id: "follow-tier-onboarding", kind: "follow-through", dimension: "tier", turns: ["What are the steps of the client onboarding process?", "Tier 1 in Mexico."] },
  { id: "follow-tier-service-level", kind: "follow-through", dimension: "tier", turns: ["What service level does a client get?", "Tier 2."] },
  { id: "follow-segment-pps", kind: "follow-through", dimension: "segment", turns: ["What does the PPS+ proposal look like for my client?", "Enterprise."] },
];

type Outcome = "asked" | "answered-all" | "answered-one" | "answered-generic";

function asked(r: TurnResult): boolean {
  const text = r.text.trim();
  return r.turnKind === "clarifying-question" || (/[?¿]["')\]*_]*$/.test(text) && text.length < 700);
}

function classify(r: TurnResult, values: RegExp[] | undefined): Outcome {
  if (asked(r)) return "asked";
  const named = (values ?? []).filter((v) => v.test(r.text)).length;
  return named >= 2 ? "answered-all" : named === 1 ? "answered-one" : "answered-generic";
}

// A short direct answer ("Tier 2 accounts get...") is still an answer: only an empty or question-shaped reply is not.
const substantive = (r: TurnResult) => !asked(r) && r.turnKind !== "no-grounded-answer" && r.text.length >= 150;

interface RunResult {
  id: string;
  kind: Kind;
  dimension: Dimension;
  /** Did this run do the right thing. */
  ok: boolean;
  outcome: string;
  firstReply: string;
}

function judge(s: Scenario, turns: TurnResult[]): { ok: boolean; outcome: string } {
  const first = turns[0];
  switch (s.kind) {
    case "must-ask": {
      const o = classify(first, s.values);
      return { ok: o === "asked" || o === "answered-all", outcome: o };
    }
    case "must-not-ask":
    case "pre-supplied":
      return { ok: !asked(first), outcome: asked(first) ? "asked" : "answered" };
    case "follow-through": {
      const second = turns[1];
      const firstAsked = asked(first);
      return { ok: substantive(second), outcome: `${firstAsked ? "asked" : "answered-first"} then ${substantive(second) ? "answered" : asked(second) ? "asked-again" : "thin"}` };
    }
  }
}

const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "n/a");

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const only = process.argv.slice(2).find((a) => !a.startsWith("--") && SCENARIOS.some((s) => s.id === a));
  const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : undefined;
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  const corpus = loadCorpus();
  console.log(`Context-asking eval -- provider: ${resolveReasoningProvider()}, runs per scenario: ${runs}, scenarios: ${scenarios.length}\n`);

  const results: RunResult[] = [];
  for (const s of scenarios) {
    const own: RunResult[] = [];
    for (let i = 0; i < runs; i++) {
      try {
        const turns = await converse(corpus, s.turns);
        const { ok, outcome } = judge(s, turns);
        own.push({ id: s.id, kind: s.kind, dimension: s.dimension, ok, outcome, firstReply: turns[0].text.replace(/\s+/g, " ").slice(0, 260) });
      } catch (err) {
        console.log(`  ${s.id} run ${i + 1}: ERROR ${String((err as Error).message ?? err).slice(0, 120)}`);
      }
    }
    results.push(...own);
    const outcomes = own.reduce<Record<string, number>>((m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
    console.log(`${s.kind.padEnd(14)} ${s.dimension.padEnd(8)} ${s.id.padEnd(28)} ok ${pct(own.filter((r) => r.ok).length, own.length).padEnd(11)} ${JSON.stringify(outcomes)}`);
    for (const bad of own.filter((r) => !r.ok).slice(0, 1)) console.log(`    e.g. [${bad.outcome}] ${bad.firstReply}`);
  }

  console.log("\n=== SUMMARY");
  const by = (pred: (r: RunResult) => boolean) => results.filter(pred);
  const rate = (rs: RunResult[]) => pct(rs.filter((r) => r.ok).length, rs.length);
  console.log(`must-ask        asks or covers every variant: ${rate(by((r) => r.kind === "must-ask"))}`);
  for (const d of ["tier", "segment", "role", "region"] as Dimension[]) {
    const rs = by((r) => r.kind === "must-ask" && r.dimension === d);
    const silent = rs.filter((r) => r.outcome === "answered-one").length;
    if (rs.length) console.log(`  ${d.padEnd(8)} ${rate(rs)}  silent pick of one value: ${pct(silent, rs.length)}  answered without naming any value: ${pct(rs.filter((r) => r.outcome === "answered-generic").length, rs.length)}`);
  }
  const noAsk = by((r) => r.kind === "must-not-ask");
  const given = by((r) => r.kind === "pre-supplied");
  console.log(`must-not-ask    answers without asking: ${rate(noAsk)}  (over-ask ${pct(noAsk.filter((r) => !r.ok).length, noAsk.length)})`);
  console.log(`pre-supplied    answers without asking again: ${rate(given)}`);
  console.log(`follow-through  answers once context is given: ${rate(by((r) => r.kind === "follow-through"))}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ runs, results }, null, 2));
}

main();
