/**
 * Regression suite built from real pilot conversations (2026-10-30), with follow-up variants. Live model on the production corpus
 * (calls a model; not part of `npm test`). Each scenario names the fix it exercises:
 *
 *   F1  search context across short turns   the reply to a clarifying question must not lose the question's words or language
 *   F2  material-dimension clarification    after region, ask for the dimension that changes the answer (sales channel) only when it does
 *   F3  answerability                       a source that announces a process is not the process: say so up front
 *   F4  scope-aware synthesis               conditional guidance is not presented as general guidance
 *   guard                                   a new topic resets the search; a general question is not answered with a question
 *
 * Judges are deterministic text checks, except the F4 rubric, which asks the model a fixed yes/no question about the answer.
 *
 *   HUBI_CONTENT_REPOSITORY_PATH="Content Repository (prod)" GOOGLE_CLOUD_PROJECT=<project> HUBI_REASONING_PROVIDER=gemini \
 *   EVAL_RUNS=3 node --experimental-strip-types scripts/eval-pilot-conversations.ts [scenario-id | fix-tag] [--json out.json]
 */
import { writeFileSync } from "node:fs";
import { resolveReasoningProvider, getReasoningEngine } from "../lib/runtime/reasoningEngine.ts";
import { converse, loadCorpus, type TurnResult } from "./lib/liveConversation.ts";

type Fix = "F1" | "F2" | "F3" | "F4" | "guard";

interface Verdict {
  ok: boolean;
  why: string;
}

interface Scenario {
  id: string;
  fix: Fix;
  /** The real pilot conversation this came from, or a variant of it. */
  origin: "pilot" | "variant";
  turns: string[];
  judge: (turns: TurnResult[]) => Verdict | Promise<Verdict>;
}

const asked = (r: TurnResult) => r.turnKind === "clarifying-question" || (/[?¿]["')\]*_]*$/.test(r.text.trim()) && r.text.trim().length < 700);
const substantive = (r: TurnResult) => !asked(r) && r.turnKind !== "no-grounded-answer" && r.text.length >= 200;

// The SS Latam onboarding training lays the process out as stages: presentation in the sale, overview and preparation, internal alignment (M0), implementation meeting (M1), communication strategy (M2), W4C training, launch actions, then 30- and 60-day checkpoints.
const STAGE_TERMS = [/\bM0\b|alineaci|alignment/i, /\bM1\b|implementaci|implementation/i, /\bM2\b|comunicaci|communication/i, /W4C|training|capacitaci/i, /launch|lanzamiento/i, /checkpoint|30[- ]day|60[- ]day|30 d[ií]as|60 d[ií]as/i, /presentation|presentaci/i, /overview|visi[oó]n general|prepar/i, /C-level/i, /agreement|acuerdo/i];
const NO_STEPS_CLAIM = /(does not|do not|doesn't|don't|cannot|can't|not|no) (\w+ ){0,4}(detail|list|provide|provided|contain|include|outline|specify|specific)\b[^.]{0,60}\bsteps?|\bsteps?\b[^.]{0,40}\b(not|aren't|isn't) (\w+ ){0,3}(provided|available|detailed|listed)/i;
const ADMITS_NO_STEPS = /(do not|don't|does not|doesn't|cannot|can't|no) (\w+ ){0,5}(steps?|step-by-step|list the steps|detail)|not (\w+ ){0,3}(available|documented|in (the|my) (knowledge|sources))|only (a |an )?(training|announcement|mention)|\bsteps?\b[^.]{0,40}\b(not|aren't|isn't) (\w+ ){0,3}(provided|available|detailed|listed)/i;
const DIRECT = /\b(direct|direta|direto|diret[oa]s?|venda direta|SMB|order form|magic link)\b/i;
const PARTNER = /\b(partner|partners|parceiro|parceiros|indireto|indireta|indirect|canal|channel|Pluxee|Alelo|Ticket|Hagata)\b/i;
const PARTNER_NAMES = /\b(Pluxee|Alelo|Hagata)\b/;

function stageHits(text: string): number {
  return STAGE_TERMS.filter((re) => re.test(text)).length;
}
const listItems = (text: string) => (text.match(/^\s*(?:\d+[.)]|[-*•])\s+/gm) ?? []).length;

function onboardingGivesSteps(turns: TurnResult[]): Verdict {
  const last = turns[turns.length - 1];
  if (asked(last)) return { ok: false, why: "asked again instead of answering" };
  if (NO_STEPS_CLAIM.test(last.text)) return { ok: false, why: "said the steps are not available" };
  const stages = stageHits(last.text);
  const items = listItems(last.text);
  return stages >= 3 && items >= 3 ? { ok: true, why: `${items} list items, ${stages} stage terms` } : { ok: false, why: `only ${items} list items and ${stages} stage terms` };
}

/** The yes/no rubric question the F4 judge asks the model; the answer being judged is quoted verbatim. */
const F4_RUBRIC =
  "You are checking an answer written for a sales team. Question: does the answer mix content that applies only to one specific region, customer tier (such as T3/T4), customer segment (such as SMB) or sales channel into its main general guidance, instead of putting it in a clearly separate part that says when it applies? Content that is clearly labelled as applying only in a stated case and set apart from the general steps does NOT count. Reply with exactly one word: YES or NO.";

async function rubricMixesScopes(answer: string): Promise<boolean> {
  const reply = await getReasoningEngine()(`${F4_RUBRIC}\n\n--- ANSWER ---\n${answer}\n--- END ---`, "You are a strict, literal reviewer. Reply with one word.", {});
  return reply.ok && /^\s*YES/i.test(reply.text);
}

const SCENARIOS: Scenario[] = [
  // Conversation 1: client onboarding steps, answered region by region.
  { id: "onboarding-mexico", fix: "F1", origin: "pilot", turns: ["What are the steps of the client onboarding process?", "Mexico"], judge: onboardingGivesSteps },
  { id: "onboarding-tier1-mexico", fix: "F1", origin: "variant", turns: ["What are the steps of the client onboarding process?", "Tier 1 in Mexico."], judge: onboardingGivesSteps },
  { id: "onboarding-region-in-question", fix: "F1", origin: "variant", turns: ["What are the steps of the client onboarding process in Mexico?"], judge: onboardingGivesSteps },
  { id: "onboarding-spanish", fix: "F1", origin: "variant", turns: ["¿Cuáles son los pasos del proceso de onboarding de clientes?", "México"], judge: onboardingGivesSteps },
  {
    id: "onboarding-us-answerability",
    fix: "F3",
    origin: "pilot",
    turns: ["What are the steps of the client onboarding process?", "US"],
    judge: (turns) => {
      const last = turns[turns.length - 1];
      const opening = last.text.slice(0, 260);
      const ok = ADMITS_NO_STEPS.test(opening) && !(stageHits(last.text) >= 3 && listItems(last.text) >= 3);
      return { ok, why: ok ? "says up front that the steps are not in the knowledge" : "describes the training or process without saying the steps are missing" };
    },
  },
  {
    id: "topic-change-after-onboarding",
    fix: "guard",
    origin: "variant",
    turns: ["What are the steps of the client onboarding process?", "Mexico", "How do I connect Salesforce to Gmail and Google Drive?"],
    judge: (turns) => {
      const last = turns[turns.length - 1];
      const ok = substantive(last) && /gmail/i.test(last.text) && !/onboarding/i.test(last.text.slice(0, 200));
      return { ok, why: ok ? "answers the new topic" : "did not answer the new topic cleanly" };
    },
  },

  // Conversation 2: a broad question whose sources mix general and conditional guidance.
  ...(["How can I explain Wellhub to a client?", "How do I explain Wellhub to a prospect?", "Como posso explicar o Wellhub para um cliente?"] as const).map(
    (q, i): Scenario => ({
      id: `explain-wellhub-${i + 1}`,
      fix: "F4",
      origin: i === 0 ? "pilot" : "variant",
      turns: [q],
      judge: async (turns) => {
        const last = turns[0];
        if (asked(last)) return { ok: false, why: "asked a question to a general request" };
        const mixes = await rubricMixesScopes(last.text);
        return { ok: !mixes, why: mixes ? "mixes region/tier/segment-specific content into the general guidance" : "keeps conditional guidance separate or absent" };
      },
    })
  ),

  // Conversation 3: which contract; region, then sales channel.
  {
    id: "contract-brazil",
    fix: "F2",
    origin: "pilot",
    turns: ["Qual contrato devo usar?", "Brasil"],
    judge: (turns) => {
      const last = turns[turns.length - 1];
      const channelQuestion = asked(last) && /(direct|direta|direto|indireto|indirect|canal|channel|parceir|partner)/i.test(last.text);
      const bothChannels = !asked(last) && DIRECT.test(last.text) && PARTNER.test(last.text);
      const silentPartner = !asked(last) && PARTNER_NAMES.test(last.text) && !DIRECT.test(last.text);
      return { ok: channelQuestion || bothChannels, why: channelQuestion ? "asks which channel" : bothChannels ? "answers for both channels" : silentPartner ? "silently assumed the partner channel" : "neither asks nor covers both channels" };
    },
  },
  {
    id: "contract-brazil-english",
    fix: "F2",
    origin: "variant",
    turns: ["Which contract should I use?", "Brazil"],
    judge: (turns) => {
      const last = turns[turns.length - 1];
      const channelQuestion = asked(last) && /(direct|indirect|channel|partner)/i.test(last.text);
      const bothChannels = !asked(last) && DIRECT.test(last.text) && PARTNER.test(last.text);
      return { ok: channelQuestion || bothChannels, why: channelQuestion ? "asks which channel" : bothChannels ? "answers for both channels" : "silently assumed one channel" };
    },
  },
  {
    id: "contract-brazil-direct",
    fix: "F2",
    origin: "variant",
    turns: ["Qual contrato devo usar?", "Brasil", "Venda direta."],
    judge: (turns) => {
      const last = turns[turns.length - 1];
      const tierQuestion = asked(last) && /\b(tier|T[0-4]|segmento|segmento|porte|tamanho)\b/i.test(last.text) && !/(regi[aã]o|canal|channel)/i.test(last.text);
      const answered = substantive(last) && DIRECT.test(last.text) && !PARTNER_NAMES.test(last.text);
      return { ok: answered || tierQuestion, why: answered ? "answers the direct contract" : tierQuestion ? "asks only for the tier" : "asked again, gave partner rules, or gave no direct contract guidance" };
    },
  },
  {
    id: "contract-brazil-partner",
    fix: "F2",
    origin: "variant",
    turns: ["Qual contrato devo usar?", "Brasil", "Por meio de parceiros."],
    judge: (turns) => {
      const last = turns[turns.length - 1];
      const ok = substantive(last) && PARTNER_NAMES.test(last.text);
      return { ok, why: ok ? "answers with the partner contract rules" : "did not give the partner contract rules" };
    },
  },
  {
    // No region given and the answer does not depend on one: Hubi may answer, but it must cover the tiers the sources split on (T3/T4 SMB versus the rest) or ask.
    id: "contract-no-context",
    fix: "guard",
    origin: "variant",
    turns: ["Which contract should I use?"],
    judge: (turns) => {
      const r = turns[0];
      const coversTiers = !asked(r) && /\bT3\b|tier 3|\bT4\b|tier 4/i.test(r.text) && /\bT0\b|\bT1\b|\bT2\b|tier [012]|enterprise/i.test(r.text);
      return { ok: asked(r) || coversTiers, why: asked(r) ? "asks first" : coversTiers ? "covers both tier groups" : "answered for one tier group without saying so" };
    },
  },
];

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 3));
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--") && a !== process.argv[process.argv.indexOf("--json") + 1]);
  const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : undefined;
  const scenarios = arg ? SCENARIOS.filter((s) => s.id === arg || s.fix === arg) : SCENARIOS;
  const corpus = loadCorpus();
  console.log(`Pilot-conversation regression -- provider: ${resolveReasoningProvider()}, runs per scenario: ${runs}, scenarios: ${scenarios.length}\n`);

  const results: { id: string; fix: Fix; ok: boolean; why: string; last: string }[] = [];
  for (const s of scenarios) {
    const own: typeof results = [];
    for (let i = 0; i < runs; i++) {
      try {
        const turns = await converse(corpus, s.turns);
        const v = await s.judge(turns);
        own.push({ id: s.id, fix: s.fix, ok: v.ok, why: v.why, last: turns[turns.length - 1].text.replace(/\s+/g, " ").slice(0, 240) });
      } catch (err) {
        own.push({ id: s.id, fix: s.fix, ok: false, why: `ERROR ${String((err as Error).message ?? err).slice(0, 100)}`, last: "" });
      }
    }
    results.push(...own);
    const reasons = own.reduce<Record<string, number>>((m, r) => ((m[r.why] = (m[r.why] ?? 0) + 1), m), {});
    console.log(`${s.fix.padEnd(5)} ${s.origin.padEnd(8)} ${s.id.padEnd(32)} ok ${own.filter((r) => r.ok).length}/${own.length}  ${JSON.stringify(reasons)}`);
    const bad = own.find((r) => !r.ok);
    if (bad) console.log(`      e.g. ${bad.last}`);
  }
  console.log("\n=== SUMMARY by fix");
  for (const f of ["F1", "F2", "F3", "F4", "guard"] as Fix[]) {
    const rs = results.filter((r) => r.fix === f);
    if (rs.length) console.log(`${f.padEnd(6)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ runs, results }, null, 2));
}

main();
