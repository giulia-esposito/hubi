import { SKIP_WITHOUT_CORPUS } from "./helpers/corpus.ts";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import type { ScoredChunk } from "../lib/retrieval/index.ts";
import { applyApplicability } from "../lib/applicability/evaluate.ts";
import { detectAudienceConflict } from "../lib/applicability/audience.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";
import { buildIndex } from "../lib/retrieval/index.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import type { BenchmarkCase } from "../lib/retrieval/benchmark.ts";

// Offline, deterministic. Two fixes from the context-asking eval baseline:
//  sources written for different audiences, with the user's audience unstated, raise an audience notice.
// It only ever adds a notice to the prompt; it never forces a question on its own.

let n = 0;
function chunk(documentId: string, extra: Partial<Chunk> = {}): Chunk {
  return { id: `${documentId}#${n++}`, documentId, documentTitle: documentId, heading: null, text: `text of ${documentId}`, citationUrl: null, citationUrlType: null, ...extra };
}
const scored = (chunks: Chunk[], scores?: number[]): ScoredChunk[] => chunks.map((c, i) => ({ chunk: c, score: scores?.[i] ?? 20 - i }));

const GLOBAL = { regions: ["Global"], regionScope: "global" as const };
const REGIONAL = { regions: ["SS Latam"], regionScope: "regional" as const };

describe("sources for different audiences", () => {
  const sales = chunk("sales-coaching", { audience: ["Sales"] });
  const cs = chunk("cs-coaching", { audience: ["CS"] });
  const salesCsWe = chunk("broad", { audience: ["Sales", "CS", "WE"] });
  const everyone = chunk("everyone", { audience: ["All Revenue"] });
  const unlabelled = chunk("unlabelled");

  test("two documents with audience labels that share nothing are a conflict, with their source numbers", () => {
    const c = detectAudienceConflict(scored([sales, cs, cs]), ["How should I run a coaching session?"]);
    assert.deepEqual(c?.groups.map((g) => [g.audience, g.sources]), [[["Sales"], [1]], [["CS"], [2, 3]]]);
  });

  test("overlapping labels, everyone-labels and unlabelled sources are not a conflict", () => {
    assert.equal(detectAudienceConflict(scored([sales, salesCsWe]), ["q"]), null);
    assert.equal(detectAudienceConflict(scored([sales, everyone]), ["q"]), null);
    assert.equal(detectAudienceConflict(scored([sales, unlabelled]), ["q"]), null);
    assert.equal(detectAudienceConflict(scored([sales, sales]), ["q"]), null, "one audience is not a conflict");
  });

  test("it stays quiet when the user has named one of the audiences, including by alias", () => {
    for (const said of ["I'm in CS. How do I run a coaching session?", "As a client success manager, how do I run it?", "Sales rep here, how do I run it?"]) {
      assert.equal(detectAudienceConflict(scored([sales, cs]), [said]), null, said);
    }
  });

  test("enterprise versus SMB labels conflict, and naming a segment resolves them", () => {
    const ent = chunk("ent-doc", { audience: ["ENT"] });
    const smb = chunk("smb-doc", { audience: ["SMB"] });
    assert.ok(detectAudienceConflict(scored([ent, smb]), ["What does the proposal look like?"]));
    assert.equal(detectAudienceConflict(scored([ent, smb]), ["For an enterprise client, what does the proposal look like?"]), null);
  });

  test("the prompt carries the notice, naming audiences and sources, and tells the model not to merge them", () => {
    const results = scored([sales, cs]);
    const prompt = buildPrompt("How should I run a coaching session?", results, [], { ...applyApplicability([], results, 5), audienceConflict: detectAudienceConflict(results, ["q"]) ?? undefined });
    assert.match(prompt, /\[Audience notice\]/);
    assert.match(prompt, /Sales \(Source 1\) versus CS \(Source 2\)/);
    assert.match(prompt, /do not merge them/);
  });

  test("no conflict, no notice", () => {
    const results = scored([sales, sales]);
    const prompt = buildPrompt("q", results, [], applyApplicability([], results, 5));
    assert.ok(!prompt.includes("[Audience notice]"));
  });
});

describe("through retrieveApplicable", () => {
  const docs = [
    chunk("sales-coaching", { audience: ["Sales"], heading: "Coaching session", text: "coaching session deal skills sales", regions: ["Global"], regionScope: "global" }),
    chunk("cs-coaching", { audience: ["CS"], heading: "Coaching session", text: "coaching session deal skills client success", regions: ["Global"], regionScope: "global" }),
    chunk("other", { heading: "Pricing", text: "pricing model per subscriber", regions: ["Global"], regionScope: "global" }),
  ];
  const index = buildIndex(docs);

  test("a coaching question with no role gets an audience conflict; naming the role removes it", () => {
    const q = "how do I run a coaching session on deal skills";
    assert.ok(retrieveApplicable(index, q, [q], {}).decision.audienceConflict);
    const named = `${q} as a CS manager`;
    assert.equal(retrieveApplicable(index, named, [named], {}).decision.audienceConflict, undefined);
  });

  test("an unrelated question gets none", () => {
    const q = "what is the pricing model per subscriber";
    assert.equal(retrieveApplicable(index, q, [q], {}).decision.audienceConflict, undefined);
  });
});

describe("strong regional match: ask for the region instead of a dead end", () => {
  const generic = (i: number) => chunk(`generic-${i}`, GLOBAL);
  const regional = (id = "regional-process", extra: Partial<Chunk> = {}) => chunk(id, { ...REGIONAL, ...extra });

  test("off unless asked for: the default behaviour is unchanged", () => {
    const ranked = scored([generic(0), generic(1), regional()], [10, 9, 8]);
    const d = applyApplicability([], ranked, 5);
    assert.equal(d.mode, "notice", "the old behaviour: a regional chunk inside the window only raises a notice");
    assert.equal(d.clarifyReason, undefined);
  });

  test("a regional chunk scoring at least the ratio of the best, region unknown, gates the turn with the reason and the region", () => {
    const ranked = scored([generic(0), generic(1), generic(2), generic(3), generic(4), regional()], [10, 9.5, 9, 8.5, 8, 7.4]);
    const d = applyApplicability([], ranked, 5, { strongRegionalRatio: 0.7 });
    assert.equal(d.mode, "must-clarify");
    assert.equal(d.clarifyReason, "strong-regional-match");
    assert.deepEqual(d.withheldRegions, ["SS Latam"]);
    assert.equal(d.eligible.length, 0, "no content is sent to the model");
  });

  test("a weaker regional chunk does not", () => {
    const ranked = scored([generic(0), generic(1), regional()], [10, 9, 6.9]);
    const d = applyApplicability([], ranked, 5, { strongRegionalRatio: 0.7 });
    assert.equal(d.clarifyReason, undefined);
    assert.notEqual(d.mode, "must-clarify");
  });

  test("it does not fire once the user's region is known, even if the regional chunk is the best match", () => {
    const ranked = scored([generic(0), regional()], [10, 9.9]);
    const d = applyApplicability(["SS Latam"], ranked, 5, { strongRegionalRatio: 0.7 });
    assert.equal(d.mode, "none");
    assert.equal(d.clarifyReason, undefined);
  });

  test("a mismatching region (the user is elsewhere) is not a strong match to ask about", () => {
    const ranked = scored([generic(0), regional()], [10, 9.9]);
    assert.notEqual(applyApplicability(["Brazil"], ranked, 5, { strongRegionalRatio: 0.7 }).clarifyReason, "strong-regional-match");
  });

  test("a second retrieval pass (gate: false) never gates on it", () => {
    const ranked = scored([generic(0), regional()], [10, 9.5]);
    const d = applyApplicability([], ranked, 5, { gate: false, strongRegionalRatio: 0.7 });
    assert.notEqual(d.mode, "must-clarify");
  });

  test("the gated prompt names the best regional material and asks only for the region", () => {
    const ranked = scored([generic(0), regional()], [10, 9.5]);
    const d = applyApplicability([], ranked, 5, { strongRegionalRatio: 0.7 });
    const prompt = buildPrompt("What are the steps of the client onboarding process?", d.eligible, [], d);
    assert.match(prompt, /The best approved material for this question is specific to SS Latam/);
    assert.match(prompt, /ONLY one short clarifying question asking which region applies/);
    assert.match(prompt, /CLARIFYING_QUESTION/);
  });
});

describe("real corpus: the strong-regional rule is rare and lands only where context matters", { skip: SKIP_WITHOUT_CORPUS }, () => {
  const { index } = buildGovernedIndex(ingestContentRepository("Content Repository").chunks);
  const gold: BenchmarkCase[] = JSON.parse(readFileSync("benchmarks/retrieval/gold.json", "utf8"));
  const recorded = JSON.parse(readFileSync("benchmarks/retrieval/expansions.json", "utf8")) as Record<string, { terms: string; reason: "non-english-query" | "weak-lexical-match" }>;
  const evalQuestions = [
    "What service level does a client get?",
    "What does the PPS+ proposal look like for my client?",
    "How do I put together the contract and the order form?",
    "How should I run a Work the Deal coaching session?",
    "What should I know about competition law when I talk to a client?",
    "What is Per Subscriber (PPS) pricing?",
    "What is the Flat Fee pricing model?",
    "How do I create effective cadences in Salesloft?",
    "Which trainings are mandatory for the revenue team?",
    "How are referral deals handled for revenue credit?",
    "What is the Wellhubverse?",
    "How do I connect Salesforce to Gmail and Google Drive?",
    "Write me an elevator pitch.",
    "What meetings do I have to do for onboarding a Tier 1 client in Mexico?",
    "What service level does a Tier 2 client get?",
    "For an Enterprise client, what does the PPS+ proposal look like?",
    "I'm in the US. What should I know about competition law when I talk to a client?",
  ];

  const triggered = (messages: string[], expansion?: { terms: string; reason: "non-english-query" | "weak-lexical-match" }) =>
    retrieveApplicable(index, messages.join(" "), messages, { expansion: expansion?.terms ? expansion : undefined }).decision.clarifyReason === "strong-regional-match";

  test("the onboarding question now becomes a region question instead of a dead end", () => {
    assert.equal(triggered(["What are the steps of the client onboarding process?"]), true);
  });

  test("none of the general, context-supplied, or retrieval-benchmark questions is turned into a question by it", () => {
    for (const q of evalQuestions) assert.equal(triggered([q]), false, q);
    for (const g of gold) {
      const messages = [g.regionContext, g.question].filter((m): m is string => Boolean(m));
      assert.equal(triggered(messages, recorded[g.id]), false, g.id);
    }
  });

  test("the one other known trigger is the vague contract-differences question, a tier-dependent case", () => {
    assert.equal(triggered(["What are the contract differences I need to know for my client?"]), true);
  });
});
