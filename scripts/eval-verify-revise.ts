/**
 * Measures the verify-and-revise prototype (lib/runtime/verifiedGeneration.ts)
 * against the plain single-call pipeline on Business Assistance requests, on
 * the real corpus and the configured provider (calls a live model; not part of
 * `npm test`).
 *
 * Two arms per scenario, interleaved so provider drift hits both equally:
 *   baseline  one streamed-style call, no verification
 *   verified  the same prompt through generateWithVerification (buffered,
 *             checked, at most one revision call)
 *
 * What it reports, per scenario:
 *   - violations (figures / value language that no retrieved chunk contains)
 *     in the baseline answers, in the verified arm's first drafts, and in the
 *     verified arm's final answers
 *   - how often the revision was triggered and accepted
 *   - latency: baseline model time vs verified total time, and the extra time
 *     of the revision call when it ran
 *   - a rough count of sentences with causal / strengthening vocabulary per
 *     arm, as an independent signal: the verifier does not look for these, so
 *     this shows what it leaves alone
 *
 * The violation count is the same check the verifier uses to decide, so a drop
 * in it proves the loop does what it is built for, not that every claim is
 * faithful. Read the printed before/after examples for that.
 *
 *   GOOGLE_CLOUD_PROJECT=<project> HUBI_REASONING_PROVIDER=gemini \
 *   EVAL_RUNS=5 node --experimental-strip-types scripts/eval-verify-revise.ts [scenario-id]
 */
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { getReasoningEngine, resolveReasoningProvider, type ReasoningEngine } from "../lib/runtime/reasoningEngine.ts";
import { extractResponseTags } from "../lib/runtime/turnKind.ts";
import { verifyClaims } from "../lib/runtime/claimVerifier.ts";
import { generateWithVerification, type VerificationInfo } from "../lib/runtime/verifiedGeneration.ts";
import type { Turn } from "../lib/runtime/sessionState.ts";
import { CAUSAL_STRENGTHENING, splitSentences } from "./lib/claimFidelityChecks.ts";
import { loadCorpus } from "./lib/liveConversation.ts";

const corpus = loadCorpus();

interface Scenario {
  id: string;
  describes: string;
  /** User messages; all but the last are answered once (baseline) to build a shared history. */
  turns: string[];
}

const SCENARIOS: Scenario[] = [
  { id: "pitch-generic", describes: "A. generic pitch", turns: ["Write me an elevator pitch."] },
  { id: "pitch-prospect", describes: "B. pitch to a prospect", turns: ["How can I present Wellhub to a prospect? Write a 1-min elevator pitch."] },
  {
    id: "pitch-tailoring",
    describes: "C. follow-up tailoring (financial industry, enterprise)",
    turns: ["How can I present Wellhub to a prospect? Write a 1-min elevator pitch.", "A company from the financial industry, enterprise size."],
  },
  { id: "email-intro", describes: "another artifact type: intro email", turns: ["Draft a short email introducing Wellhub to a prospect."] },
  { id: "talk-track", describes: "another artifact type: talk track", turns: ["Create a discovery talk track for a new client."] },
];

const RETRY = /429|RESOURCE_EXHAUSTED|Resource exhausted/i;

/** The real engine, with 429 retry, recording every response so the first draft can be shown after a revision. */
function recordingEngine(log: string[]): ReasoningEngine {
  const real = getReasoningEngine();
  return async (prompt, system, opts) => {
    let res = await real(prompt, system, opts);
    for (let attempt = 1; attempt <= 2 && !res.ok && RETRY.test(String(res.error)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 8000 * attempt));
      res = await real(prompt, system, opts);
    }
    log.push(res.text);
    return res;
  };
}

interface ArmRun {
  finalText: string;
  violations: number;
  causalSentences: number;
  modelMs: number;
  verification: VerificationInfo | null;
  firstDraft: string;
  planningMode: string;
}

function causalCount(text: string): number {
  return splitSentences(text).filter((s) => CAUSAL_STRENGTHENING.test(s)).length;
}

async function runArm(s: Scenario, history: Turn[], verify: boolean): Promise<ArmRun> {
  const userMessages = s.turns;
  const question = userMessages[userMessages.length - 1];
  const { decision } = retrieveApplicable(corpus.index, userMessages.join(" "), userMessages, {
    lastPlanningMode: userMessages.length > 1 ? "business-assistance" : undefined,
  });
  const retrievedTexts = decision.eligible.map((r) => r.chunk.text);
  const prompt = buildPrompt(question, decision.eligible, history, decision);

  const log: string[] = [];
  const turn = await generateWithVerification({ engine: recordingEngine(log), prompt, systemPrompt: HUBI_SYSTEM_PROMPT, retrievedTexts, verify });
  if (!turn.response.ok) throw new Error(`engine error: ${turn.response.error}`);
  const final = extractResponseTags(turn.response.text);
  return {
    finalText: final.text,
    violations: verifyClaims(final.text, retrievedTexts).violations.length,
    causalSentences: causalCount(final.text),
    modelMs: turn.response.durationMs,
    verification: verify ? turn.verification : null,
    firstDraft: extractResponseTags(log[0] ?? "").text,
    planningMode: final.planningMode,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "n/a");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  console.log(`Verify-and-revise measurement -- provider: ${resolveReasoningProvider()}, runs per arm per scenario: ${runs}\n`);

  const summary: string[] = [];
  for (const s of scenarios) {
    console.log(`=== ${s.id}: ${s.describes}`);
    // Shared history for follow-up scenarios: earlier turns are answered once, without verification.
    const history: Turn[] = [];
    for (let i = 0; i < s.turns.length - 1; i++) {
      const earlier: Scenario = { ...s, turns: s.turns.slice(0, i + 1) };
      const answer = await runArm(earlier, history.slice(), false);
      history.push({ role: "user", content: s.turns[i] }, { role: "assistant", content: answer.finalText });
    }

    const base: ArmRun[] = [];
    const ver: ArmRun[] = [];
    let shown = 0;
    for (let i = 0; i < runs; i++) {
      try {
        base.push(await runArm(s, history, false));
        const v = await runArm(s, history, true);
        ver.push(v);
        if (v.verification?.revised && shown < 1) {
          shown++;
          console.log(`--- example (run ${i + 1}): revision ${v.verification.revisionAccepted ? "ACCEPTED" : "DISCARDED"}; flagged: ${v.verification.phrases.join(", ")}`);
          console.log("    FIRST DRAFT:\n" + v.firstDraft.split("\n").map((l) => `    | ${l}`).join("\n"));
          console.log("    FINAL:\n" + v.finalText.split("\n").map((l) => `    | ${l}`).join("\n"));
        }
      } catch (err) {
        console.log(`--- run ${i + 1}: ERROR ${String((err as Error).message ?? err).slice(0, 140)}`);
      }
    }

    const ba = ver.filter((v) => v.planningMode === "business-assistance");
    const checked = ver.filter((v) => v.verification?.checked);
    const triggered = ver.filter((v) => v.verification?.revised);
    const accepted = ver.filter((v) => v.verification?.revisionAccepted);
    const draftViolating = checked.filter((v) => (v.verification?.violationsBefore ?? 0) > 0);
    const baseViolating = base.filter((b) => b.violations > 0);
    const finalViolating = ver.filter((v) => v.violations > 0);
    const extra = triggered.map((v) => v.verification?.extraMs ?? 0);

    const lines = [
      `  baseline answers with violations      ${pct(baseViolating.length, base.length)}`,
      `  verified arm: drafts with violations  ${pct(draftViolating.length, checked.length)}  (business-assistance turns: ${ba.length}/${ver.length})`,
      `  verified arm: revision triggered      ${pct(triggered.length, ver.length)} | accepted ${pct(accepted.length, triggered.length)}`,
      `  verified arm: FINAL with violations   ${pct(finalViolating.length, ver.length)}`,
      `  causal-vocabulary sentences per answer: baseline ${mean(base.map((b) => b.causalSentences)).toFixed(1)} | verified final ${mean(ver.map((v) => v.causalSentences)).toFixed(1)}`,
      `  latency: baseline ${secs(mean(base.map((b) => b.modelMs)))} | verified ${secs(mean(ver.map((v) => v.modelMs)))} overall` +
        (triggered.length ? ` | revision adds ${secs(mean(extra))} (max ${secs(Math.max(...extra))}) when triggered` : ""),
    ];
    console.log(lines.join("\n"));
    console.log("");
    summary.push(`${s.id.padEnd(16)} baseline viol ${pct(baseViolating.length, base.length).padEnd(11)} | draft viol ${pct(draftViolating.length, checked.length).padEnd(11)} | final viol ${pct(finalViolating.length, ver.length).padEnd(11)} | triggered ${pct(triggered.length, ver.length).padEnd(11)} | latency ${secs(mean(base.map((b) => b.modelMs)))} -> ${secs(mean(ver.map((v) => v.modelMs)))}`);
  }
  console.log("=== SUMMARY");
  for (const line of summary) console.log(line);
}

main();
