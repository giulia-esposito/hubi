/**
 * Does Hubi keep a named product apart from a similarly named one?
 *
 * Live evaluation on the real corpus and the configured provider (calls a model; not part of `npm test`).
 * It exists because of a pilot answer: a tester asked how to position "extra check-ins", which the knowledge
 * does not contain, and Hubi answered about "International Check-ins", a different add-on, as if they were the same.
 *
 *   absent    the user names something the corpus never mentions, and a similarly named item exists.
 *             Good: Hubi says the approved knowledge does not cover it (it may offer the similar item as a
 *             different offer, as a question). Bad: it says the user's term "refers to" or "appears to be"
 *             the similar item and answers about that.
 *   present   the named item is in the corpus. Good: Hubi answers. Bad: it refuses or stalls.
 *
 * An "absent" scenario is only valid while its term is really absent: the eval checks this against the corpus
 * and flags the scenario when a document starts to mention it.
 *
 *   GOOGLE_CLOUD_PROJECT=<project> HUBI_REASONING_PROVIDER=gemini HUBI_CONTENT_REPOSITORY_PATH="Content Repository (prod)" \
 *   EVAL_RUNS=3 node --experimental-strip-types scripts/eval-named-terms.ts
 */
import { resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { converse, loadCorpus, type LiveCorpus, type TurnResult } from "./lib/liveConversation.ts";

interface Scenario {
  id: string;
  kind: "absent" | "present";
  question: string;
  /** A second user message sent after the first reply (for example the answer to a clarifying question); the last reply is judged. */
  followUp?: string;
  /** absent: the name the user used (must not appear in the corpus) and the similar name Hubi must not substitute. */
  term?: RegExp;
  similar?: RegExp;
}

const SCENARIOS: Scenario[] = [
  { id: "absent-extra-check-ins", kind: "absent", question: "How do I position extra check-ins for a discovery meeting?", term: /extra\s+check-?ins?/i, similar: /international\s+check-?ins?/i },
  { id: "absent-premium-check-ins", kind: "absent", question: "What is the pricing for the Premium Check-ins add-on?", term: /premium\s+check-?ins?/i, similar: /international\s+check-?ins?/i },
  { id: "absent-nutrition-plus", kind: "absent", question: "How do I sell the Nutrition Plus SKU to an SMB client?", term: /nutrition\s+plus/i, similar: /nutrition/i },
  // Hubi may first ask which segment applies; the answer to that must still not turn "Family Plus" into "Family Member".
  { id: "absent-family-plus", kind: "absent", question: "What are the eligibility rules for Family Plus?", followUp: "For an SMB client.", term: /family\s+plus/i, similar: /family\s+member/i },
  { id: "present-international-check-ins", kind: "present", question: "How do I position International Check-ins for a discovery meeting?" },
  { id: "present-global-digital-plan", kind: "present", question: "What is the Global Digital Plan?" },
  { id: "present-roe", kind: "present", question: "What are the Rules of Engagement?" },
];

const IDENTITY = /(refers?\s+to|appears?\s+to\s+(be|refer)|is\s+the\s+same\s+as|is\s+also\s+(known|called)|you(?:'re|\s+are)\s+referring\s+to|(?:also\s+)?known\s+as)/gi;
const NOT_COVERED = /(does\s+not|doesn't|do\s+not|don't|cannot|can't|no)\s+(contain|cover|include|have|mention|specif|information|guidance|approved|details|reference)|not\s+(covered|available|found|mentioned|described|in\s+the)/i;

/**
 * True when the answer says the user's own term means the similar item: the user's term shortly before an identity
 * phrase ("refers to", "appears to be") and the similar item shortly after it, or "which appears to be what you're
 * referring to" after the similar item. "The knowledge does refer to International Check-ins" is not such a claim.
 */
function claimsIdentity(text: string, term: RegExp, similar: RegExp): boolean {
  for (const m of text.matchAll(IDENTITY)) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 70), at);
    const after = text.slice(at, at + 140);
    if (term.test(before) && similar.test(after)) return true;
    if (/referring\s+to/i.test(m[0]) && similar.test(text.slice(Math.max(0, at - 140), at)) && !/\?\s*$/.test(text.slice(at, at + 60))) return true;
  }
  return false;
}

function judge(s: Scenario, r: TurnResult): { ok: boolean; outcome: string } {
  if (s.kind === "present") {
    const ok = r.turnKind !== "no-grounded-answer" && r.text.length >= 150;
    return { ok, outcome: ok ? "answered" : "did not answer" };
  }
  const claim = claimsIdentity(r.text, s.term!, s.similar!);
  const covered = NOT_COVERED.test(r.text);
  if (claim) return { ok: false, outcome: "equated the term with the similar item" };
  if (!covered) return { ok: false, outcome: "answered without saying the term is not covered" };
  return { ok: true, outcome: "said it is not covered" };
}

function termInCorpus(corpus: LiveCorpus, term: RegExp): boolean {
  return corpus.index.indexed.some((entry) => term.test(entry.chunk.text));
}

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const only = process.argv.slice(2).find((a) => SCENARIOS.some((s) => s.id === a));
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  const corpus = loadCorpus();
  console.log(`Named-terms eval -- provider: ${resolveReasoningProvider()}, runs per scenario: ${runs}\n`);

  let pass = 0;
  let total = 0;
  const byKind: Record<string, [number, number]> = { absent: [0, 0], present: [0, 0] };
  for (const s of scenarios) {
    if (s.kind === "absent" && termInCorpus(corpus, s.term!)) console.log(`WARNING ${s.id}: the corpus now mentions the term, so this scenario no longer tests an absent name.`);
    const outcomes: string[] = [];
    let ok = 0;
    for (let i = 0; i < runs; i++) {
      const replies = await converse(corpus, s.followUp ? [s.question, s.followUp] : [s.question]);
      const j = judge(s, replies[replies.length - 1]);
      if (j.ok) ok++;
      outcomes.push(j.outcome);
    }
    pass += ok;
    total += runs;
    byKind[s.kind][0] += ok;
    byKind[s.kind][1] += runs;
    console.log(`${ok === runs ? "PASS" : "FAIL"} ${s.id.padEnd(34)} ${ok}/${runs}  ${[...new Set(outcomes)].join("; ")}`);
  }
  console.log(`\nabsent names kept apart: ${byKind.absent[0]}/${byKind.absent[1]}   present names answered: ${byKind.present[0]}/${byKind.present[1]}   overall ${pass}/${total}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
