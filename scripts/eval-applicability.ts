/**
 * Live applicability evaluation for the Retrieval V2 applicability slice
 * (Findings #001/#002). Runs the real pipeline end to end on the real
 * Content Repository: ingestion -> governed index (AI Eligibility gate) ->
 * retrieval -> Applicability Layer -> prompt -> the configured reasoning
 * provider. NOT part of `npm test`: it calls a live model.
 *
 * What it checks is what only a model can show: that a gated turn comes back
 * as a clarifying question in the user's language with no regional process
 * content, that a known-region turn never gets another region's process, that
 * Global content still answers, that reliance on content with unspecified
 * region is disclosed, and that pitch flows still work with the Not Eligible
 * document removed. The deterministic guarantees (nothing withheld reaches the
 * prompt, RKC-000021 is never indexed) are in tests/applicability.test.ts and
 * tests/aiEligibility.test.ts.
 *
 *   GOOGLE_CLOUD_PROJECT=<project> HUBI_REASONING_PROVIDER=gemini \
 *   EVAL_RUNS=5 node --experimental-strip-types scripts/eval-applicability.ts [scenario-id]
 */
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { getReasoningEngine, resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { extractResponseTags } from "../lib/runtime/turnKind.ts";
import { formatCitation } from "../lib/runtime/citationBuilder.ts";
import type { Turn } from "../lib/runtime/sessionState.ts";

const { chunks } = ingestContentRepository("Content Repository");
const { index, excluded } = buildGovernedIndex(chunks);

interface TurnResult {
  text: string;
  turnKind: string;
  planningMode: string;
  mode: string;
  taskRegions: string[];
  citations: string[];
  statuses: string[];
}

const RETRY = /429|RESOURCE_EXHAUSTED|Resource exhausted/i;

async function ask(prompt: string) {
  const engine = getReasoningEngine();
  let last = await engine(prompt, HUBI_SYSTEM_PROMPT);
  for (let attempt = 1; attempt <= 2 && !last.ok && RETRY.test(String(last.error)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 8000 * attempt));
    last = await engine(prompt, HUBI_SYSTEM_PROMPT);
  }
  return last;
}

/** One conversation through the real pipeline; returns the result of every turn. */
async function converse(userMessages: string[]): Promise<TurnResult[]> {
  const history: Turn[] = [];
  const asked: string[] = [];
  const out: TurnResult[] = [];
  for (const question of userMessages) {
    asked.push(question);
    const { raw, decision } = retrieveApplicable(index, asked.join(" "), asked);
    let text: string;
    let turnKind = "unknown";
    let planningMode = "unknown";
    if (raw.length === 0) {
      text = "(deterministic refusal: nothing retrieved)";
      turnKind = "no-grounded-answer";
    } else {
      const response = await ask(buildPrompt(question, decision.eligible, history, decision));
      if (!response.ok) throw new Error(`engine error: ${response.error}`);
      ({ text, turnKind, planningMode } = extractResponseTags(response.text));
    }
    out.push({
      text,
      turnKind,
      planningMode,
      mode: decision.mode,
      taskRegions: decision.taskRegions,
      citations: decision.eligible.map((r) => formatCitation(r.chunk)),
      statuses: decision.eligibleStatuses,
    });
    history.push({ role: "user", content: question }, { role: "assistant", content: text });
  }
  return out;
}

type Check = (turns: TurnResult[]) => string | null;
const last = (turns: TurnResult[]) => turns[turns.length - 1];

const SSL_PROCESS = /\bM[0-2]\b|kick[ -]?off|health checkpoint|paso a paso|implementaci[oó]n/i;
const SPANISH = /[¿¡áéíóúñ]|\b(qué|cuál|región|regiones|indica|podrías|puedes|necesito)\b/i;
const MENTIONS_REGION = /region|región|regi[oã]o/i;
const DISCLOSES_UNSPECIFIED =
  /not specified|does(?: not|n't) specify|no region|region (?:is |was )?not (?:specified|stated|indicated)|can(?:not|'t) confirm|unable to confirm|not (?:confirmed|clear) for|no (?:est[aá]|se especifica)|n[aã]o (?:est[aá] )?especificad|regional scope/i;

const kindIs = (kind: string): Check => (t) => (last(t).turnKind === kind ? null : `turnKind ${last(t).turnKind}, expected ${kind}`);
const gateMode = (mode: string): Check => (t) => (last(t).mode === mode ? null : `applicability mode ${last(t).mode}, expected ${mode}`);
const noProcessContent: Check = (t) => (SSL_PROCESS.test(last(t).text) ? "response contains regional process content" : null);
const shortReply = (n: number): Check => (t) => (last(t).text.length <= n ? null : `reply too long for a clarifying question (${last(t).text.length} > ${n})`);
const inSpanish: Check = (t) => (SPANISH.test(last(t).text) ? null : "reply is not in Spanish");
const asksRegion: Check = (t) => (MENTIONS_REGION.test(last(t).text) && /[?¿]/.test(last(t).text) ? null : "reply does not ask about the region");
const noRkc21: Check = (t) => (t.some((x) => x.citations.some((c) => c.includes("RKO 2026"))) ? "cites the RKO 2026 Elevator Pitch Submission (Not Eligible)" : null);
const taskRegionIs = (region: string): Check => (t) => (last(t).taskRegions.includes(region) ? null : `task region ${JSON.stringify(last(t).taskRegions)}, expected ${region}`);
const noSslCitation: Check = (t) => (last(t).citations.some((c) => c.includes("[SSL]")) ? "cites an SS Latam document for a different region" : null);
const planning = (mode: string): Check => (t) => (last(t).planningMode === mode ? null : `planningMode ${last(t).planningMode}, expected ${mode}`);
const notRefusal: Check = (t) => (/(does not|doesn't|do not|don't) (contain|include|have) (a |an )?(pre-?written|ready-?made)/i.test(last(t).text) ? "says no pre-written pitch exists" : null);
const disclosesUnspecified: Check = (t) => (DISCLOSES_UNSPECIFIED.test(last(t).text) ? null : "does not disclose that the source's region is not specified");
const usedUnspecified: Check = (t) => (last(t).statuses.includes("unspecified") ? null : "scenario invalid: no unspecified source was used");
const answered: Check = (t) => (last(t).turnKind === "grounded-answer" ? null : `turnKind ${last(t).turnKind}, expected grounded-answer`);

interface Scenario {
  id: string;
  describes: string;
  turns: string[];
  checks: Check[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "spanish-no-region",
    describes: "Finding #002 scenario 2: Spanish question, no region -> clarifying question in Spanish, no SS Latam process",
    turns: ["¿Cuál es el proceso de onboarding del cliente en mi región?"],
    checks: [gateMode("must-clarify"), kindIs("clarifying-question"), asksRegion, inSpanish, noProcessContent, shortReply(700)],
  },
  {
    id: "meetings-then-brazil",
    describes: "Finding #001 multi-turn: onboarding meetings, then 'Tier 1 in Brazil' -> never the SS Latam meeting sequence as the Brazil answer",
    turns: ["What meetings do I have to do for client onboarding?", "Tier 1 in Brazil"],
    checks: [taskRegionIs("Brazil"), noProcessContent, noSslCitation],
  },
  {
    id: "meetings-no-region",
    describes: "Finding #001 first turn: no region stated -> asks which region before describing any regional process",
    turns: ["What meetings do I have to do for client onboarding?"],
    checks: [kindIs("clarifying-question"), asksRegion, noProcessContent],
  },
  {
    id: "global-no-clarification",
    describes: "Global content stays eligible: a question the Global documents answer is answered, not turned into a region question",
    turns: ["How do I create effective cadences in Salesloft?"],
    checks: [answered],
  },
  {
    id: "unspecified-disclosure",
    describes: "A region-sensitive answer that relies on content with unspecified region must say so",
    turns: ["As a rep in Brazil, which sales tools can I get access to and how long does access take?"],
    checks: [usedUnspecified, disclosesUnspecified],
  },
  {
    id: "pitch-after-exclusion",
    describes: "Pitch flow still works with RKC-000021 (Not Eligible) removed",
    turns: ["How can I present Wellhub to a prospect? Write a 1-min elevator pitch."],
    checks: [planning("business-assistance"), notRefusal, noRkc21, answered],
  },
  {
    id: "pitch-write-me",
    describes: "Generic pitch request after exclusion",
    turns: ["Write me an elevator pitch."],
    checks: [planning("business-assistance"), noRkc21],
  },
  {
    id: "pitch-do-we-have",
    describes: "Existence question after exclusion: answers from remaining eligible material and never cites the excluded document",
    turns: ["Do we have an elevator pitch?"],
    checks: [planning("knowledge-retrieval"), noRkc21],
  },
];

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  console.log(`Applicability eval -- provider: ${resolveReasoningProvider()}, runs per scenario: ${runs}`);
  for (const e of excluded) console.log(`Excluded by AI Eligibility (${e.aiEligibility}): ${e.contentId} (${e.chunkCount} chunks)`);
  console.log("");

  let passed = 0;
  let total = 0;
  const summary: string[] = [];
  for (const s of scenarios) {
    console.log(`=== ${s.id}: ${s.describes}`);
    s.turns.forEach((t, i) => console.log(`    turn ${i + 1}: ${t}`));
    let ok = 0;
    for (let i = 0; i < runs; i++) {
      total++;
      let turns: TurnResult[];
      try {
        turns = await converse(s.turns);
      } catch (err) {
        console.log(`--- run ${i + 1}: ERROR ${String((err as Error).message ?? err).slice(0, 160)}`);
        continue;
      }
      const failures = s.checks.map((c) => c(turns)).filter((f): f is string => f !== null);
      if (failures.length === 0) {
        ok++;
        passed++;
      }
      const l = last(turns);
      console.log(`--- run ${i + 1}: ${failures.length === 0 ? "PASS" : "FAIL"} [gate: ${l.mode}] [turnKind: ${l.turnKind}] [planningMode: ${l.planningMode}] [task region: ${l.taskRegions.join(", ") || "unknown"}]`);
      for (const f of failures) console.log(`    x ${f}`);
      console.log(l.text.split("\n").map((line) => `    | ${line}`).join("\n"));
      if (l.citations.length) console.log(l.citations.map((c) => `    cite ${c}`).join("\n"));
    }
    console.log(`=== ${s.id}: ${ok}/${runs} passed\n`);
    summary.push(`${s.id.padEnd(26)} ${ok}/${runs}`);
  }
  console.log("=== SUMMARY");
  for (const line of summary) console.log(line);
  console.log(`Overall: ${passed}/${total} passed`);
  process.exitCode = passed === total ? 0 : 1;
}

main();
