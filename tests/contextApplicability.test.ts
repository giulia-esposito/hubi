import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import type { ScoredChunk } from "../lib/retrieval/index.ts";
import { applyApplicability } from "../lib/applicability/evaluate.ts";
import { detectAudienceConflict } from "../lib/applicability/audience.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";
import { buildIndex } from "../lib/retrieval/index.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";

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
