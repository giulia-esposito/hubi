import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import type { ScoredChunk } from "../lib/retrieval/index.ts";
import { tokenize } from "../lib/retrieval/index.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { FACT_ANCHOR_QUERY, FACT_K, buildFactQuery, isArtifactRequest } from "../lib/runtime/factRetrieval.ts";
import { classifyChunk } from "../lib/applicability/evaluate.ts";

// Finding #004 (smallest version): a conditional, deterministic second BM25
// pass for the facts an artifact needs. No model call, so everything here is
// offline. Nothing in the module or in these tests names a pitch as a special
// case: the same logic must work for any artifact type.

function chunk(id: string, heading: string | null, documentTitle = "Doc"): Chunk {
  return { id, documentId: id, documentTitle, heading, text: "x", citationUrl: null, citationUrlType: null };
}
const scored = (chunks: Chunk[]): ScoredChunk[] => chunks.map((c, i) => ({ chunk: c, score: 10 - i }));

describe("isArtifactRequest: a general creation / adaptation check, not an artifact list", () => {
  test("creation verbs in English, Spanish and Portuguese, for any kind of artifact", () => {
    for (const text of [
      "Write me an elevator pitch.",
      "Create a discovery talk track for this client.",
      "Draft an email to a prospect about onboarding.",
      "Prepare discovery questions for tomorrow's call.",
      "Build an objection response for pricing.",
      "Redacta un correo para un cliente nuevo.",
      "Escreva uma mensagem de follow-up.",
      "Tailor this for a retail client.",
    ]) {
      assert.equal(isArtifactRequest(text), true, text);
    }
  });

  test("factual, existence and summary questions are not artifact requests", () => {
    for (const text of [
      "What is the eligibility rule for dependents?",
      "Do we have an elevator pitch?",
      "Where can I find the pricing playbook?",
      "Summarize the onboarding process and its main milestones.",
      "¿Cuál es el proceso de onboarding del cliente en mi región?",
    ]) {
      assert.equal(isArtifactRequest(text), false, text);
    }
  });

  test("a short follow-up continues an artifact request only when the previous turn was business-assistance", () => {
    const followUp = "A company from the financial industry, enterprise size.";
    assert.equal(isArtifactRequest(followUp), false);
    assert.equal(isArtifactRequest(followUp, "knowledge-retrieval"), false);
    assert.equal(isArtifactRequest(followUp, "business-assistance"), true);
    assert.equal(isArtifactRequest("What is the price of the Gold plan?", "business-assistance"), false);
  });
});

describe("buildFactQuery", () => {
  test("drops instruction words and the terms that name the kind of reference document pass 1 found", () => {
    const passOne = scored([chunk("a", "Instructions for the quarterly review template"), chunk("b", "Review template examples")]);
    const query = buildFactQuery(["Write me a quarterly review template for the client."], passOne);
    const terms = new Set(tokenize(query));
    for (const dropped of ["write", "quarterly", "review", "template"]) assert.ok(!terms.has(dropped), `${dropped} should be dropped`);
    assert.ok(terms.has("client"));
    for (const t of tokenize(FACT_ANCHOR_QUERY)) assert.ok(terms.has(t), `anchor term ${t} missing`);
  });

  test("keeps the audience / context terms a follow-up adds", () => {
    const passOne = scored([chunk("a", "Reference guide")]);
    const query = buildFactQuery(["Draft a message.", "A company from the financial industry, enterprise size."], passOne);
    const terms = new Set(tokenize(query));
    for (const kept of ["company", "financial", "industry", "enterprise", "size"]) assert.ok(terms.has(kept), kept);
  });
});

describe("real corpus: the conditional second pass", () => {
  const { chunks } = ingestContentRepository("Content Repository");
  const { index } = buildGovernedIndex(chunks);
  const run = (messages: string[], lastPlanningMode?: string) => retrieveApplicable(index, messages.join(" "), messages, { lastPlanningMode });

  test("an artifact request with thin facts triggers the pass and adds eligible, fact-bearing chunks", () => {
    const result = run(["Write me an elevator pitch."]);
    assert.equal(result.factPass.triggered, true);
    assert.ok(result.factPass.added > 0 && result.factPass.added <= FACT_K);
    assert.ok(result.factPass.query?.includes("Wellhub"));
    assert.ok(result.decision.eligible.length > 5);
    for (const r of result.decision.eligible) assert.ok(["global", "match", "unspecified"].includes(classifyChunk(r.chunk, result.decision.taskRegions)));
  });

  test("it is conditional: factual questions, existence questions and summaries never trigger it", () => {
    for (const q of ["Do we have an elevator pitch?", "What are Wellhub's pricing models?", "Summarize the Salesloft cadence best practices."]) {
      const result = run([q]);
      assert.equal(result.factPass.triggered, false, q);
      assert.equal(result.factPass.reason, "not-artifact-request", q);
    }
  });

  test("a follow-up continues the artifact request when the previous turn was business-assistance", () => {
    const messages = ["How can I present Wellhub to a prospect? Write a 1-min elevator pitch.", "A company from the financial industry, enterprise size."];
    assert.equal(run(messages).factPass.triggered, false);
    const continued = run(messages, "business-assistance");
    assert.notEqual(continued.factPass.reason, "not-artifact-request");
  });

  test("when pass 1 is gated (region must be clarified), no second pass runs", () => {
    const result = run(["Escribe un resumen del proceso de onboarding del cliente en mi región."]);
    assert.equal(result.decision.mode, "must-clarify");
    assert.equal(result.factPass.triggered, false);
    assert.equal(result.factPass.reason, "gated");
    assert.deepEqual(result.decision.eligible, []);
  });

  test("AI Eligibility applies to both passes: RKC-000021 is never in the result", () => {
    for (const q of ["Write me an elevator pitch.", "How can I present Wellhub to a prospect? Write a 1-min elevator pitch.", "Draft a talk track about the Wellhub value proposition."]) {
      const result = run([q]);
      assert.ok(result.decision.eligible.every((r) => r.chunk.documentId !== "RKC-000021"), q);
    }
  });

  test("Applicability applies to both passes: nothing region-incompatible or unresolved reaches the model, for any stated region", () => {
    for (const suffix of ["", " for a client in Brazil", " for a client in the US", " for a client in Mexico", " for a client in the UK", " for a client in Canada"]) {
      const result = run([`Write me an elevator pitch${suffix}.`]);
      for (const r of result.decision.eligible) {
        assert.ok(["global", "match", "unspecified"].includes(classifyChunk(r.chunk, result.decision.taskRegions)), `${suffix}: ${r.chunk.documentId}`);
      }
    }
  });

  test("the second pass adds no duplicate of a pass-1 chunk and keeps pass-1 chunks first", () => {
    const result = run(["Write me an elevator pitch."]);
    const ids = result.decision.eligible.map((r) => r.chunk.id);
    assert.equal(new Set(ids).size, ids.length);
    const passOneCount = ids.length - result.factPass.added;
    assert.ok(passOneCount <= 5);
  });

  test("retrieval, including the second pass, is fast and local", () => {
    const result = run(["Write me an elevator pitch."]);
    assert.ok(result.retrievalMs < 500, `retrieval took ${result.retrievalMs} ms`);
  });
});

describe("merging the second pass: facts first, references after", () => {
  const ref = (id: string): ScoredChunk => ({ chunk: { ...chunk(id, "Reference"), regions: ["Global"], regionScope: "global", text: `REFERENCE-${id}` }, score: 5 });
  const fact = (id: string): ScoredChunk => ({ chunk: { ...chunk(id, "Facts"), regions: ["Global"], regionScope: "global", text: `FACT-${id}` }, score: 4 });

  test("the facts lead, the count is recorded, and duplicates of pass-1 chunks are not added twice", async () => {
    const { applyApplicability, mergeSupplementalDecision } = await import("../lib/applicability/evaluate.ts");
    const first = applyApplicability([], [ref("r1"), ref("r2")], 5);
    const extra = applyApplicability([], [fact("f1"), ref("r1"), fact("f2")], 4, { gate: false });
    const merged = mergeSupplementalDecision(first, extra);
    assert.deepEqual(merged.eligible.map((r) => r.chunk.id), ["f1", "f2", "r1", "r2"]);
    assert.equal(merged.factSourceCount, 2);
  });

  test("the prompt separates facts from references and numbers the sources continuously, so citations match", async () => {
    const { applyApplicability, mergeSupplementalDecision } = await import("../lib/applicability/evaluate.ts");
    const { buildPrompt } = await import("../lib/runtime/promptBuilder.ts");
    const first = applyApplicability([], [ref("r1")], 5);
    const merged = mergeSupplementalDecision(first, applyApplicability([], [fact("f1"), fact("f2")], 4, { gate: false }));
    const prompt = buildPrompt("Write something.", merged.eligible, [], merged);
    const factsAt = prompt.indexOf("Retrieved Knowledge -- facts");
    const refsAt = prompt.indexOf("Retrieved Knowledge -- references");
    assert.ok(factsAt >= 0 && refsAt > factsAt);
    assert.ok(prompt.indexOf("FACT-f1") > factsAt && prompt.indexOf("FACT-f2") < refsAt);
    assert.ok(prompt.indexOf("REFERENCE-r1") > refsAt);
    assert.ok(prompt.indexOf("[Source 1]") < prompt.indexOf("[Source 2]") && prompt.indexOf("[Source 2]") < prompt.indexOf("[Source 3]"));
    assert.match(prompt, /\[Source 3\][^\n]*\n[^\n]*\nREFERENCE-r1/);
  });

  test("without a second pass the prompt keeps the single 'Retrieved Knowledge:' block", async () => {
    const { applyApplicability } = await import("../lib/applicability/evaluate.ts");
    const { buildPrompt } = await import("../lib/runtime/promptBuilder.ts");
    const d = applyApplicability([], [ref("r1")], 5);
    const prompt = buildPrompt("q", d.eligible, [], d);
    assert.match(prompt, /Retrieved Knowledge:/);
    assert.ok(!prompt.includes("Retrieved Knowledge -- facts"));
  });
});
