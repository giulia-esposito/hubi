/**
 * Live Task Planning V0 evaluation. NOT part of `npm test` (which is offline
 * by design): this calls the real reasoning provider configured by
 * HUBI_REASONING_PROVIDER (claude-code by default, or gemini with ADC).
 *
 * Retrieval is deterministic: each scenario injects fixed fixture chunks into
 * the real BM25 index and uses the real search() + buildPrompt() + system
 * prompt, so results don't depend on the content corpus. The fixtures are
 * synthetic stand-ins that borrow the product name "Wellhub" so the model is
 * not asked to infer the company; their content is invented and is NOT real
 * Wellhub knowledge. For the real-corpus check of the
 * elevator-pitch regression, run:
 *   npm run ask -- "How can I present Wellhub to a prospect? Write a 1-min elevator pitch."
 *
 * Model output varies, so this reports a pass rate per scenario over
 * EVAL_RUNS runs (default 1) and prints each response for human review. It is
 * a behavioral signal, not a CI gate.
 *
 *   node --experimental-strip-types scripts/eval-task-planning.ts
 *   EVAL_RUNS=3 HUBI_REASONING_PROVIDER=gemini node ... scripts/eval-task-planning.ts [scenario-id]
 */
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { buildIndex, search } from "../lib/retrieval/index.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { getReasoningEngine, resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { extractResponseTags } from "../lib/runtime/turnKind.ts";
import type { PlanningMode } from "../lib/runtime/planningMode.ts";
import type { Turn } from "../lib/runtime/sessionState.ts";

function chunk(id: string, title: string, heading: string, text: string): Chunk {
  return { id, documentId: id, documentTitle: title, heading, text, citationUrl: null, citationUrlType: null };
}

// --- Synthetic fixtures (placeholders for governed knowledge, not real facts) ---

const PITCH_FIXTURES: Chunk[] = [
  chunk("pos", "Positioning Guide", "Core message",
    "Wellhub gives employees one subscription to many gyms, studios and wellbeing apps. Its core message is engagement: people use benefits they actually enjoy. Company clients see higher participation in wellbeing programs."),
  chunk("score", "Pitch Scorecard", "What a strong pitch includes",
    "A strong prospect pitch scores well when it opens with a business problem, names the core value proposition in one sentence, uses one proof point, and ends with a clear next step. Keep it conversational and under one minute."),
  chunk("story", "Sales Narrative Examples", "Example opening",
    "Example opening: 'Most companies offer wellbeing benefits that only a few employees use. We help every employee find something they want to do.'"),
];

const TALK_TRACK_FIXTURES: Chunk[] = [
  chunk("disc", "Discovery Best Practices", "Running a discovery call",
    "Good discovery calls open with rapport and agenda, ask open questions about current benefits, uncover stakeholders and success criteria, and close by agreeing next steps. Avoid pitching before understanding the client's priorities."),
  chunk("prod", "Product Overview", "What Wellhub offers",
    "Wellhub offers employees a single subscription covering gyms, studios and digital wellbeing apps, with company-level reporting on participation."),
];

const ONBOARDING_FIXTURES: Chunk[] = [
  chunk("onb1", "Onboarding Playbook", "Milestones",
    "Client onboarding has three milestones: kickoff meeting in week one, platform setup and employee communication in weeks two and three, and a first results review at day 60."),
  chunk("onb2", "Onboarding Playbook", "Owners",
    "The Customer Success Manager owns the kickoff meeting and the day-60 review; the Implementation team owns platform setup."),
];

const ELIGIBILITY_FIXTURES: Chunk[] = [
  chunk("elig", "Eligibility Policy", "Dependents",
    "Employees' dependents are eligible for the plan when the client enables the family option. The family option is configured by the client at contract signature."),
];

const PARTIAL_FIXTURES: Chunk[] = [
  ...PITCH_FIXTURES,
  chunk("nostat", "Positioning Guide", "Scope", "No quantified burnout-reduction results are published in approved materials."),
];

type Check = (r: { text: string; raw: string; mode: PlanningMode; kind: string }) => string | null;

const REFUSAL = /(does not|doesn't|do not|don't) (contain|include|have) (a |an )?(pre-?written|ready-?made|exact)|can't (give|write|provide|create) you|cannot (give|write|provide|create)/i;

const expectMode = (m: PlanningMode): Check => (r) => (r.mode === m ? null : `planningMode ${r.mode}, expected ${m}`);
const noRefusal: Check = (r) => (REFUSAL.test(r.text) ? "response refuses or says no pre-written artifact exists" : null);
const notNoAnswer: Check = (r) => (r.kind === "no-grounded-answer" ? "turnKind is no-grounded-answer" : null);
const minLength = (n: number): Check => (r) => (r.text.length >= n ? null : `response too short (${r.text.length} < ${n})`);
const notContains = (re: RegExp, why: string): Check => (r) => (re.test(r.text) ? why : null);

// --- Checks that apply to every scenario (see runOnce) ---

// The visible text must never contain an internal tag, however malformed.
const noTagLeak: Check = (r) => (/\[\[\s*HUBI/i.test(r.text) ? "internal [[HUBI...]] tag leaked into the visible text" : null);
// Reports whether the model followed the canonical line-1 format. The parser
// tolerates drift, but drift is a prompt-compliance signal worth counting.
const canonicalModeTag: Check = (r) =>
  /^\s*\[\[HUBI:MODE:[A-Z_]+\]\]/.test(r.raw) ? null : "line 1 is not a canonical [[HUBI:MODE:...]] tag";
// A turn kind must always be reported, and a mode must always have been parsed.
const kindReported: Check = (r) => (r.kind === "unknown" ? "no turn-kind tag was parsed" : null);

// --- Artifact-quality checks (pitch-style scenarios) ---

// An artifact should be written, not handed back as a fill-in-the-blank
// template, and must not carry placeholder statistics.
const noTemplatePlaceholders: Check = (r) =>
  /(^|[^a-z])X\s?%|\[\s*\*{0,2}(mention|state|provide|insert|add)|e\.g\.,? our clients/i.test(r.text)
    ? "artifact is a fill-in-the-blank template or contains a placeholder statistic"
    : null;
// Benefits that none of the pitch fixtures state; asserting them is ungrounded.
const noUngroundedPitchBenefits: Check = (r) =>
  /(^|[^a-z])(productivity|retention|turnover|roi|return on investment|cost sav|healthcare costs?|absenteeism)([^a-z]|$)/i.test(r.text)
    ? "asserts a benefit that is not in the retrieved knowledge (productivity/retention/ROI/etc.)"
    : null;
// For thin-retrieval scenarios: asking, or a bracketed skeleton, is fine, but
// no figure of any kind may appear (every percentage or number-with-unit that
// is not in the fixtures would be invented) and no example outcome is offered
// to fill a gap ("e.g., X% increase in ...").
const noInventedFigures: Check = (r) =>
  /\d+\s?%|(^|[^a-z])X\s?%|e\.g\.,?[^\]\n]*(increase|reduction|improv|saving)/i.test(r.text)
    ? "offers an invented figure or example outcome to fill a missing fact"
    : null;
const PITCH_QUALITY: Check[] = [noTemplatePlaceholders, noUngroundedPitchBenefits];

const UNIVERSAL_CHECKS: Check[] = [noTagLeak, canonicalModeTag, kindReported];

interface Scenario {
  id: string;
  question: string;
  fixtures: Chunk[];
  history?: Turn[];
  /** Full set of user messages used for retrieval (matches accumulatedUserQuery). */
  retrievalQuery?: string;
  checks: Check[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "ba-pitch",
    question: "How can I present Wellhub to a prospect? Write a 1-min elevator pitch.",
    fixtures: PITCH_FIXTURES,
    checks: [expectMode("business-assistance"), noRefusal, notNoAnswer, minLength(250), ...PITCH_QUALITY],
  },
  {
    id: "ba-pitch-followup",
    question: "A company from the financial industry, enterprise size.",
    history: [
      { role: "user", content: "How can I present Wellhub to a prospect? Write a 1-min elevator pitch." },
      { role: "assistant", content: "Here is a one-minute pitch: ..." },
    ],
    retrievalQuery: "How can I present Wellhub to a prospect? Write a 1-min elevator pitch. A company from the financial industry, enterprise size.",
    fixtures: PITCH_FIXTURES,
    checks: [expectMode("business-assistance"), noRefusal, notNoAnswer, minLength(250), ...PITCH_QUALITY],
  },
  {
    id: "ba-talk-track",
    question: "Create a discovery talk track for this client.",
    fixtures: TALK_TRACK_FIXTURES,
    checks: [expectMode("business-assistance"), notNoAnswer, minLength(300), notContains(/^\s*(summary|in summary)/i, "reads like a playbook summary")],
  },
  {
    id: "ba-partial-unsupported",
    question: "Write a short opening for a prospect whose employees are burned out, and include the percentage by which we reduce burnout.",
    fixtures: PARTIAL_FIXTURES,
    checks: [
      expectMode("business-assistance"),
      notNoAnswer,
      minLength(200),
      notContains(/\d+\s?%/, "contains a percentage although none is supported by the retrieved knowledge"),
      noTemplatePlaceholders,
    ],
  },
  {
    id: "kr-eligibility",
    question: "What is the eligibility rule for dependents?",
    fixtures: ELIGIBILITY_FIXTURES,
    checks: [expectMode("knowledge-retrieval")],
  },
  {
    id: "ks-onboarding",
    question: "Summarize the onboarding process and its main milestones.",
    fixtures: ONBOARDING_FIXTURES,
    checks: [expectMode("knowledge-synthesis"), notNoAnswer],
  },
  {
    id: "amb-do-we-have",
    question: "Do we have an elevator pitch?",
    fixtures: PITCH_FIXTURES,
    checks: [expectMode("knowledge-retrieval")],
  },
  {
    id: "amb-summarize-guidance",
    question: "Summarize our elevator pitch guidance.",
    fixtures: PITCH_FIXTURES,
    checks: [expectMode("knowledge-synthesis"), notNoAnswer],
  },
  {
    // KNOWN RETRIEVAL GAP, kept deliberately (see docs/validation-findings.md,
    // Finding #004): for this query BM25 retrieves only the pitch scorecard.
    // The positioning chunk shares no query token ("write", "me", "elevator",
    // "pitch") so it is never retrieved, and the model correctly sees no
    // Wellhub facts to build a pitch from. With the facts in context the same
    // prompt writes a finished pitch (verified 5/5 outside this harness), so
    // this scenario does NOT test "write a finished pitch". It tests that,
    // when facts are missing, the model asks or writes a skeleton WITHOUT
    // inventing examples, statistics or benefits.
    id: "amb-write-me",
    question: "Write me an elevator pitch.",
    fixtures: PITCH_FIXTURES,
    checks: [expectMode("business-assistance"), noInventedFigures, noUngroundedPitchBenefits],
  },
];

async function runOnce(s: Scenario): Promise<{ ok: boolean; failures: string[]; mode: PlanningMode; kind: string; text: string; raw: string }> {
  const index = buildIndex(s.fixtures);
  const results = search(index, s.retrievalQuery ?? s.question, 5);
  const prompt = buildPrompt(s.question, results, s.history ?? []);
  const response = await getReasoningEngine()(prompt, HUBI_SYSTEM_PROMPT);
  if (!response.ok) return { ok: false, failures: [`engine error: ${response.error}`], mode: "unknown", kind: "unknown", text: "", raw: "" };
  const { text, turnKind, planningMode } = extractResponseTags(response.text);
  const input = { text, raw: response.text, mode: planningMode, kind: turnKind };
  const failures = [...UNIVERSAL_CHECKS, ...s.checks].map((c) => c(input)).filter((f): f is string => f !== null);
  return { ok: failures.length === 0, failures, mode: planningMode, kind: turnKind, text, raw: response.text };
}

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  console.log(`Task Planning V0 eval -- provider: ${resolveReasoningProvider()}, runs per scenario: ${runs}\n`);

  let passed = 0;
  let total = 0;
  for (const s of scenarios) {
    let scenarioPasses = 0;
    console.log(`=== ${s.id}: ${s.question}`);
    for (let i = 0; i < runs; i++) {
      const r = await runOnce(s);
      total++;
      if (r.ok) {
        scenarioPasses++;
        passed++;
      }
      console.log(`--- run ${i + 1}: ${r.ok ? "PASS" : "FAIL"} [planningMode: ${r.mode}] [turnKind: ${r.kind}]`);
      for (const f of r.failures) console.log(`    x ${f}`);
      console.log(r.text.split("\n").map((l) => `    | ${l}`).join("\n"));
    }
    console.log(`=== ${s.id}: ${scenarioPasses}/${runs} passed\n`);
  }
  console.log(`Overall: ${passed}/${total} passed`);
  process.exitCode = passed === total ? 0 : 1;
}

main();
