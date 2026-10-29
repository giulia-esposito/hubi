/**
 * Does Hubi apply the source-governance rule (docs/source-selection-design.md, section 2)?
 *
 * Live evaluation through the real prompt builder and the configured provider (calls a model; not part of `npm test`).
 * The cases are synthetic: the facts are invented so they cannot be confused with real Wellhub policy, and each case is
 * built from labelled sources exactly as the pipeline would hand them to the model.
 *
 *   supersession       a newer source explicitly replaces the older rule: use the new one and say it changed.
 *   conflict           the sources disagree and nothing says one supersedes: flag it and give both.
 *   agreement          the sources agree: answer normally, no discrepancy talk.
 *   announcement-only  a newsletter only announces a training: answer from the source with the steps.
 *   mention-only       a newer source mentions the topic without changing the rule: the official source stands.
 *
 *   GOOGLE_CLOUD_PROJECT=<project> HUBI_REASONING_PROVIDER=gemini EVAL_RUNS=5 node --experimental-strip-types scripts/eval-source-conflicts.ts [case-id]
 */
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { getReasoningEngine, resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { extractResponseTags } from "../lib/runtime/turnKind.ts";
import { detectSourceGovernance } from "../lib/governance/sourceGovernance.ts";

function source(id: string, title: string, contentType: string, collection: string, date: string, text: string): { chunk: Chunk; score: number } {
  return {
    score: 1,
    chunk: {
      id: `${id}::s0`,
      documentId: id,
      documentTitle: title,
      heading: null,
      text,
      citationUrl: null,
      citationUrlType: null,
      regions: ["Global"],
      regionScope: "global",
      regionRaw: "Global",
      documentDate: date,
      governance: { status: "registered", aiEligibility: "Eligible", contentType, collection },
    },
  };
}

const DIFFER = /\b(differ|differs|differing|conflict|conflicts|conflicting|discrepanc\w*|inconsisten\w*|disagree\w*|contradict\w*|not consistent)\b/i;
const CHANGED = /\b(chang\w*|updat\w*|replac\w*|supersed\w*|overrid\w*|no longer|previous\w*|earlier|before|now)\b/i;

interface Case {
  id: string;
  question: string;
  sources: ReturnType<typeof source>[];
  /** Returns null when the answer is right, otherwise what went wrong. */
  judge: (text: string) => string | null;
}

const CASES: Case[] = [
  {
    id: "supersession",
    question: "Who approves a discount, and what is the most they can approve?",
    sources: [
      source("RKC-S1", "Discount Approval Process", "Training", "Pricing Rules", "Mar 2, 2026", "Discount approval. Any discount above 5% needs sign-off from a Director. Directors can approve discounts of up to 10%."),
      source("RKC-S2", "Trending This Week", "Newsletter", "Trending This Week", "Jul 14, 2026", "Discount approval update. Effective July 1, this replaces the previous discount approval rule: Managers can now approve discounts of up to 15%, and Director sign-off is no longer required for discounts within that limit."),
    ],
    judge: (t) => (!/15\s?%/.test(t) ? "does not give the new 15% limit" : !CHANGED.test(t) ? "does not say the guidance changed" : null),
  },
  {
    id: "conflict-no-signal",
    question: "How many business days do I have to log a new opportunity?",
    sources: [
      source("RKC-C1", "Opportunity Management Basics", "Wiki Page", "Opportunities management", "Apr 6, 2026", "Every new opportunity must be logged in the CRM within 5 business days of the first meeting."),
      source("RKC-C2", "Trending This Week", "Newsletter", "Trending This Week", "Jul 14, 2026", "Reminder from RevOps: please log your new opportunities in the CRM within 2 business days of the first meeting."),
    ],
    judge: (t) => (!/\b5\b|five/i.test(t) || !/\b2\b|two/i.test(t) ? "does not give both versions" : !DIFFER.test(t) ? "does not flag the discrepancy" : null),
  },
  {
    id: "agreement",
    question: "How many business days do I have to log a new opportunity?",
    sources: [
      source("RKC-A1", "Opportunity Management Basics", "Wiki Page", "Opportunities management", "Apr 6, 2026", "Every new opportunity must be logged in the CRM within 5 business days of the first meeting."),
      source("RKC-A2", "Trending This Week", "Newsletter", "Trending This Week", "Jul 14, 2026", "Reminder from RevOps: please log your new opportunities in the CRM within 5 business days of the first meeting."),
    ],
    judge: (t) => (!/\b5\b|five/i.test(t) ? "does not give the 5 days" : DIFFER.test(t) ? "raises a discrepancy where the sources agree" : null),
  },
  {
    id: "announcement-only",
    question: "What are the steps of the renewal process?",
    sources: [
      source("RKC-N1", "Renewals Training", "Training", "Client Success Processes", "Feb 9, 2026", "Renewal process. Step 1: open the renewal opportunity 90 days before the contract end date. Step 2: confirm the contract end date with the client. Step 3: send the renewal quote. Step 4: log the outcome in the CRM."),
      source("RKC-N2", "Trending This Week", "Newsletter", "Trending This Week", "Jul 14, 2026", "New training live: the Renewals course is now available in the learning platform. Enroll today and learn how renewals work."),
    ],
    judge: (t) => (!/renewal quote/i.test(t) || !/contract end date/i.test(t) ? "does not give the steps from the training" : null),
  },
  {
    id: "mention-only",
    question: "Who has to approve a discount above 10%?",
    sources: [
      source("RKC-M1", "Discount Approval Process", "Training", "Pricing Rules", "Mar 2, 2026", "Discounts above 10% need sign-off from a Director before they are offered to the client."),
      source("RKC-M2", "Trending This Week", "Newsletter", "Trending This Week", "Jul 14, 2026", "Shout-out to the team that closed the logistics account this week with a 12% discount. Great work!"),
    ],
    judge: (t) => (!/director/i.test(t) ? "does not give the Director rule" : /\b(chang\w*|replac\w*|supersed\w*|no longer)\b/i.test(t) ? "claims the guidance changed" : null),
  },
];

const RETRY = /429|RESOURCE_EXHAUSTED|Resource exhausted/i;

async function ask(prompt: string): Promise<string> {
  const engine = getReasoningEngine();
  let last = await engine(prompt, HUBI_SYSTEM_PROMPT, {});
  for (let attempt = 1; attempt <= 2 && !last.ok && RETRY.test(String(last.error)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 8000 * attempt));
    last = await engine(prompt, HUBI_SYSTEM_PROMPT, {});
  }
  if (!last.ok) throw new Error(`engine error: ${last.error}`);
  return extractResponseTags(last.text).text;
}

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 3));
  const only = process.argv.slice(2).find((a) => CASES.some((c) => c.id === a));
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;
  console.log(`Source-conflict eval -- provider: ${resolveReasoningProvider()}, runs per case: ${runs}\n`);
  let pass = 0;
  let total = 0;
  for (const c of cases) {
    const signal = detectSourceGovernance(c.sources);
    let prompt = buildPrompt(c.question, c.sources, [], undefined);
    // EVAL_NO_NOTICE=1 removes the source notice: the baseline that shows what the notice adds.
    if (process.env.EVAL_NO_NOTICE) {
      const from = prompt.indexOf("[Source notice]");
      const to = prompt.lastIndexOf("User question:");
      if (from >= 0 && to > from) prompt = prompt.slice(0, from) + prompt.slice(to);
    }
    const failures: string[] = [];
    let first = "";
    for (let i = 0; i < runs; i++) {
      try {
        const text = await ask(prompt);
        if (i === 0) first = text.replace(/\s+/g, " ").slice(0, 300);
        const bad = c.judge(text);
        if (bad) failures.push(`${bad}: ${text.replace(/\s+/g, " ").slice(0, 220)}`);
      } catch (err) {
        failures.push(`ERROR ${String((err as Error).message ?? err).slice(0, 100)}`);
      }
    }
    total += runs;
    pass += runs - failures.length;
    console.log(`${c.id.padEnd(20)} notice ${signal ? "on " : "OFF"} ok ${runs - failures.length}/${runs}`);
    if (failures.length) console.log(`    e.g. ${failures[0]}`);
    else console.log(`    e.g. ${first}`);
  }
  console.log(`\n=== SUMMARY  ${pass}/${total} runs right`);
}

main();
