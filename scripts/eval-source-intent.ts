/**
 * What do the intent-aware reserved slots change on a real corpus? (docs/source-selection-design.md, section 3)
 * Offline, no model call. For each question it prints the answer set Hubi would send without the slots and with them, and
 * whether the kind of source the question needs is represented. Point it at the deployed corpus:
 *
 *   HUBI_CONTENT_REPOSITORY_PATH="Content Repository (prod)" node --experimental-strip-types scripts/eval-source-intent.ts
 */
import { loadCorpus } from "./lib/liveConversation.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { sourceFactsOf } from "../lib/governance/sourceFacts.ts";
import { isUpdateSource } from "../lib/governance/sourceGovernance.ts";
import type { ScoredChunk } from "../lib/retrieval/index.ts";

const QUESTIONS: { q: string; expect: "process" | "recency" | "none" }[] = [
  { q: "How do I onboard a new client?", expect: "process" },
  { q: "What are the steps of the renewal process?", expect: "process" },
  { q: "How do I create a cadence in Salesloft?", expect: "process" },
  { q: "How do I run a Work the Deal coaching session?", expect: "process" },
  { q: "What is the process to request a discount approval?", expect: "process" },
  { q: "How do I connect Salesforce to Gmail?", expect: "process" },
  { q: "How do I prepare the contract and the order form?", expect: "process" },
  { q: "What are the steps to launch a product to a client?", expect: "process" },
  { q: "What's new this week?", expect: "recency" },
  { q: "What changed recently in pricing?", expect: "recency" },
  { q: "Any updates on the Wellhubverse?", expect: "recency" },
  { q: "What are the latest product launches?", expect: "recency" },
  { q: "What is Per Subscriber (PPS) pricing?", expect: "none" },
  { q: "What is the Wellhubverse?", expect: "none" },
  { q: "Write me an elevator pitch.", expect: "none" },
  { q: "Which trainings are mandatory for the revenue team?", expect: "none" },
];

const kind = (r: ScoredChunk) => {
  const f = sourceFactsOf(r.chunk);
  return !f.contentType ? "unreg" : isUpdateSource(f.contentType, f.collection) ? "update" : "process";
};
const label = (r: ScoredChunk) => `${kind(r)}:${r.chunk.documentTitle.slice(0, 34)}`;

const corpus = loadCorpus();
let asked = 0;
let before = 0;
let after = 0;
let changed = 0;
let controlsChanged = 0;
for (const { q, expect } of QUESTIONS) {
  const res = retrieveApplicable(corpus.index, q, [q]);
  const added = new Set(res.intentPass.added.map((a) => a.chunkId));
  const withSlots = res.decision.eligible;
  const without = withSlots.filter((r) => !added.has(r.chunk.id));
  const need = expect === "process" ? "process" : "update";
  console.log(`\n[${expect}] ${q}  (gate: ${res.decision.mode}; cue: ${res.intentPass.intents.join("+") || "none"})`);
  console.log(`  without: ${without.map(label).join(" | ") || "(none)"}`);
  if (added.size > 0) console.log(`  added:   ${withSlots.filter((r) => added.has(r.chunk.id)).map(label).join(" | ")}`);
  if (expect !== "none") {
    asked++;
    if (without.some((r) => kind(r) === need)) before++;
    if (withSlots.some((r) => kind(r) === need)) after++;
  }
  if (added.size > 0) changed++;
  if (expect === "none" && added.size > 0) controlsChanged++;
}
console.log(`\n=== ${QUESTIONS.length} questions; cue questions ${asked}: needed source kind represented ${before}/${asked} without the slots, ${after}/${asked} with them; answer sets changed ${changed}; no-cue controls changed ${controlsChanged}`);
