import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { buildIndex, type ScoredChunk } from "../lib/retrieval/index.ts";
import {
  EXPANSION_SYSTEM_PROMPT,
  WEAK_SCORE,
  buildExpansionPrompt,
  detectLanguage,
  expandQuery,
  expansionEnabled,
  fuseRankings,
  fusionWeights,
  parseExpansionTerms,
  planExpansion,
  searchWithExpansion,
  stripFunctionWords,
  DOMINANT_EXPANSION_RATIO,
  type ExpansionEngine,
} from "../lib/retrieval/queryExpansion.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { withResilience } from "../lib/runtime/resilience.ts";
import type { ReasoningEngine } from "../lib/runtime/reasoningEngine.ts";

// Offline: the language guess, the trigger, the merge and the fallbacks are
// exercised with fake engines. Whether expansion improves real recall is
// measured by the retrieval benchmark (npm run eval:retrieval -- --expand).

const chunk = (id: string, text: string, heading: string | null = null): Chunk => ({ id, documentId: id, documentTitle: id, heading, text, citationUrl: null, citationUrlType: null });
const scored = (...ids: string[]): ScoredChunk[] => ids.map((id, i) => ({ chunk: chunk(id, id), score: 10 - i }));

describe("language guess", () => {
  test("English questions", () => {
    for (const q of ["How do I create effective cadences in Salesloft?", "What is the Work the Deal methodology?", "Write me an elevator pitch."]) assert.equal(detectLanguage(q), "en", q);
  });

  test("Spanish and Portuguese questions, with and without accents", () => {
    assert.equal(detectLanguage("¿Qué reuniones de onboarding tengo que hacer?"), "es");
    assert.equal(detectLanguage("Que reuniones de onboarding tengo que hacer?"), "es");
    assert.equal(detectLanguage("Porque o Launch Readiness é importante?"), "pt");
    assert.equal(detectLanguage("Por que o Launch Readiness e importante?"), "pt");
    assert.equal(detectLanguage("Quais são os motivos comuns de rejeição de uma oportunidade?"), "pt");
  });

  test("a Romance-language question that cannot be told apart is 'es-pt', still not English", () => {
    assert.equal(detectLanguage("Escríbeme un pitch de ascensor para un prospecto."), "es");
    assert.equal(detectLanguage("pitch de cliente para el prospecto"), "es");
    assert.equal(detectLanguage("reuniones de cliente"), "es-pt");
  });

  test("a bare name or an empty string is not guessed", () => {
    assert.equal(detectLanguage("Salesloft"), "unknown");
    assert.equal(detectLanguage(""), "unknown");
    assert.equal(detectLanguage("???"), "unknown");
  });
});

describe("when to expand", () => {
  test("a non-English question always expands to English, whatever its lexical score", () => {
    const plan = planExpansion("¿Qué es el modelo de precio por suscriptor?", 40);
    assert.equal(plan.expand, true);
    assert.equal(plan.reason, "non-english-query");
    assert.deepEqual(plan.targets, ["English"]);
  });

  test("an English question expands to Spanish and Portuguese only when its match is weak", () => {
    const weak = planExpansion("Why do opportunities get rejected and how do I avoid it?", WEAK_SCORE - 1);
    assert.equal(weak.expand, true);
    assert.equal(weak.reason, "weak-lexical-match");
    assert.deepEqual(weak.targets, ["Spanish", "Portuguese"]);
    const strong = planExpansion("How do I create effective cadences in Salesloft?", WEAK_SCORE + 5);
    assert.equal(strong.expand, false);
    assert.equal(strong.reason, "sufficient");
  });

  test("a very short question is never expanded on weakness alone", () => {
    assert.equal(planExpansion("Salesloft cadences", 0).expand, false);
  });

  test("the env switch turns it off", () => {
    assert.equal(expansionEnabled({}), true);
    assert.equal(expansionEnabled({ HUBI_QUERY_EXPANSION: "0" }), false);
    assert.equal(expansionEnabled({ HUBI_QUERY_EXPANSION: "1" }), true);
  });
});

describe("the model call", () => {
  test("the prompt carries the question and the target languages; the reply is cut to one safe line", () => {
    const prompt = buildExpansionPrompt("¿Qué es PPS?", ["English"]);
    assert.ok(prompt.includes("¿Qué es PPS?"));
    assert.ok(prompt.includes("English"));
    assert.ok(EXPANSION_SYSTEM_PROMPT.includes("Output only one line"));
    assert.equal(parseExpansionTerms('  "Pay per subscriber PPS pricing"  \n\nExplanation: ignore'), "Pay per subscriber PPS pricing");
    assert.equal(parseExpansionTerms("**pricing** model; [[HUBI:GROUNDED_ANSWER]]"), "pricing model");
    assert.equal(parseExpansionTerms(""), "");
    assert.ok(parseExpansionTerms("x ".repeat(500)).length <= 200);
  });

  const index = buildIndex([chunk("a", "pricing model per subscriber", "Pricing"), chunk("b", "rejeitar oportunidade contrato", "Rejeição")]);

  test("not triggered when the question is English and well matched: the engine is never called", async () => {
    const filler = Array.from({ length: 400 }, (_, i) => chunk(`f${i}`, `unrelated filler text number ${i} about something else entirely`));
    const big = buildIndex([chunk("a", "pricing model per subscriber explained pricing model subscriber", "Pricing model per subscriber"), ...filler]);
    let called = 0;
    const engine: ExpansionEngine = async () => (called++, { ok: true, text: "x" });
    const info = await expandQuery({ engine, index: big, query: "pricing model per subscriber explained", latestMessage: "pricing model per subscriber explained" });
    assert.equal(info.triggered, false);
    assert.equal(called, 0);
  });

  test("a non-English question calls the engine once with fast mode and returns the terms", async () => {
    const calls: unknown[] = [];
    const engine: ExpansionEngine = async (_p, system, opts) => (calls.push({ system, opts }), { ok: true, text: "pricing model per subscriber" });
    const info = await expandQuery({ engine, index, query: "¿Qué es el modelo de precio por suscriptor?", latestMessage: "¿Qué es el modelo de precio por suscriptor?" });
    assert.equal(info.triggered, true);
    assert.equal(info.terms, "pricing model per subscriber");
    assert.equal(info.reason, "non-english-query");
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0] as { opts: unknown }).opts, { timeoutMs: 10_000, fast: true });
  });

  test("an engine failure, an empty reply and a throw all degrade to no terms, never an error", async () => {
    const q = "¿Qué es el modelo de precio por suscriptor?";
    const failing = await expandQuery({ engine: async () => ({ ok: false, text: "", error: "429" }), index, query: q, latestMessage: q });
    assert.equal(failing.terms, "");
    assert.equal(failing.error, "429");
    const empty = await expandQuery({ engine: async () => ({ ok: true, text: "   " }), index, query: q, latestMessage: q });
    assert.equal(empty.terms, "");
    assert.equal(empty.error, "no usable terms");
    const throwing = await expandQuery({ engine: async () => Promise.reject(new Error("boom")), index, query: q, latestMessage: q });
    assert.equal(throwing.terms, "");
    assert.equal(throwing.error, "boom");
  });

  test("a helper call (fast) gets one attempt: no retries, no backoff", async () => {
    let calls = 0;
    const engine: ReasoningEngine = async () => (calls++, { ok: false, text: "", mode: "stream", durationMs: 1, error: "429 RESOURCE_EXHAUSTED" });
    const wrapped = withResilience(engine, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, budgetMs: 10_000, maxConcurrent: 0, maxQueueWaitMs: 0 });
    await wrapped("p", "s", { fast: true });
    assert.equal(calls, 1);
    await wrapped("p", "s");
    assert.equal(calls, 4);
  });
});

describe("fusion", () => {
  test("a chunk found by both rankings rises; the reported score is the best original score", () => {
    const fused = fuseRankings(
      [
        { results: scored("a", "b", "c"), weight: 1 },
        { results: scored("d", "b", "e"), weight: 1 },
      ],
      10
    );
    assert.deepEqual(fused.map((r) => r.chunk.id), ["b", "a", "d", "c", "e"]);
    assert.equal(fused[0].score, 9);
  });

  test("the limit is applied and an empty list changes nothing", () => {
    assert.equal(fuseRankings([{ results: scored("a", "b", "c"), weight: 1 }, { results: [], weight: 1 }], 2).length, 2);
    assert.deepEqual(fuseRankings([{ results: scored("a", "b"), weight: 1 }, { results: [], weight: 0.6 }], 5).map((r) => r.chunk.id), ["a", "b"]);
  });

  test("a weak English match leans on the original ranking; a non-English one trusts both equally", () => {
    assert.deepEqual(fusionWeights("non-english-query"), { original: 1, expansion: 1 });
    assert.ok(fusionWeights("weak-lexical-match").expansion < fusionWeights("weak-lexical-match").original);
  });

  test("with the lighter weight the original top results all stay above expansion-only results", () => {
    const original = scored(...Array.from({ length: 15 }, (_, i) => `o${i}`));
    const expansion = scored(...Array.from({ length: 15 }, (_, i) => `e${i}`));
    const w = fusionWeights("weak-lexical-match");
    const fused = fuseRankings([{ results: original, weight: w.original }, { results: expansion, weight: w.expansion }], 15);
    assert.ok(original.every((o) => fused.some((f) => f.chunk.id === o.chunk.id)));
  });
});

describe("retrieval with expansion", () => {
  const index = buildIndex([chunk("pricing", "per subscriber pricing model explained", "Pricing"), chunk("spanish", "reuniones de onboarding con el cliente", "Reuniones")]);

  test("terms from the expansion find a document the question's own words cannot", () => {
    const without = retrieveApplicable(index, "modelo de precio por suscriptor", ["modelo de precio por suscriptor"], {});
    assert.ok(!without.raw.some((r) => r.chunk.id === "pricing"));
    const withTerms = retrieveApplicable(index, "modelo de precio por suscriptor", ["modelo de precio por suscriptor"], {
      expansion: { terms: "pricing model per subscriber", reason: "non-english-query" },
    });
    assert.ok(withTerms.raw.some((r) => r.chunk.id === "pricing"));
  });

  test("no terms means exactly the plain result", () => {
    const plain = retrieveApplicable(index, "reuniones de onboarding", ["reuniones de onboarding"], {});
    const empty = retrieveApplicable(index, "reuniones de onboarding", ["reuniones de onboarding"], { expansion: { terms: "", reason: "non-english-query" } });
    assert.deepEqual(empty.raw.map((r) => r.chunk.id), plain.raw.map((r) => r.chunk.id));
  });
});

describe("a dominant expansion is not held below the original results", () => {
  // 20 English filler chunks that match the English question moderately, and one Spanish chunk that only the expansion finds.
  const filler = Array.from({ length: 20 }, (_, i) => chunk(`f${i}`, `client onboarding process overview number ${i} general notes about onboarding`, "Onboarding overview"));
  const spanish = chunk("es-onboarding", "pasos del proceso de incorporacion del cliente paso a paso pasos proceso incorporacion cliente", "Paso a paso");
  const index = buildIndex([...filler, spanish, ...Array.from({ length: 200 }, (_, i) => chunk(`pad${i}`, `unrelated text ${i}`))]);
  const question = "client onboarding process steps";

  test("when the expansion's best score is at least the ratio times the original best, the expansion-only chunk enters the top results", () => {
    const expansion = { terms: "pasos proceso incorporacion cliente paso", reason: "weak-lexical-match" as const };
    const fused = searchWithExpansion(index, question, expansion, 15);
    assert.ok(fused.some((r) => r.chunk.id === "es-onboarding"), "the expansion-only chunk must be among the 15");
  });

  test("when the expansion is not clearly better, the original ranking still keeps every one of its top results above expansion-only chunks", () => {
    const expansion = { terms: "client", reason: "weak-lexical-match" as const };
    const fused = searchWithExpansion(index, question, expansion, 15);
    assert.ok(!fused.some((r) => r.chunk.id === "es-onboarding"));
  });

  test("the ratio is 1.5, and a non-English question was already fused at equal weight", () => {
    assert.equal(DOMINANT_EXPANSION_RATIO, 1.5);
    assert.deepEqual(fusionWeights("non-english-query"), { original: 1, expansion: 1 });
  });
});

describe("expansion terms", () => {
  test("Spanish and Portuguese function words are removed so filler cannot look like a dominant match; content words stay", () => {
    assert.equal(stripFunctionWords("Wellhubverse qué es Wellhubverse o que é"), "Wellhubverse Wellhubverse");
    assert.equal(stripFunctionWords("pasos del proceso de incorporación do cliente"), "pasos proceso incorporación cliente");
    assert.equal(stripFunctionWords(""), "");
  });
});
