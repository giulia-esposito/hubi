import { SKIP_WITHOUT_CORPUS } from "./helpers/corpus.ts";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import { search, type ScoredChunk } from "../lib/retrieval/index.ts";
import { byCategory, compareToBaseline, matches, scoreCase, summarize, validateCases, type BenchmarkCase, type Metrics } from "../lib/retrieval/benchmark.ts";

// The scoring is pure and tested offline. Against the real corpus the benchmark
// also runs here, because it is deterministic (BM25 only, no model): a change
// to tokenization, chunking or scoring that lowers recall fails this suite.

const chunk = (documentId: string, heading: string | null = null): Chunk => ({ id: `${documentId}:${heading}`, documentId, documentTitle: documentId, heading, text: "x", citationUrl: null, citationUrlType: null });
const ranked = (...chunks: Chunk[]): ScoredChunk[] => chunks.map((c, i) => ({ chunk: c, score: 10 - i }));
const CASE: BenchmarkCase = { id: "c", category: "t", question: "q", relevant: [{ doc: "A" }, { doc: "B", heading: "pricing" }] };

describe("benchmark scoring", () => {
  test("a passage matches by document and, when given, a case-insensitive heading pattern", () => {
    assert.ok(matches(chunk("A", "anything"), { doc: "A" }));
    assert.ok(matches(chunk("B", "Flat PRICING model"), { doc: "B", heading: "pricing" }));
    assert.ok(!matches(chunk("B", "Onboarding"), { doc: "B", heading: "pricing" }));
    assert.ok(!matches(chunk("C"), { doc: "A" }));
  });

  test("rank is the first relevant chunk; found counts distinct relevant passages", () => {
    const r = scoreCase(CASE, ranked(chunk("Z"), chunk("B", "pricing"), chunk("A"), chunk("A")));
    assert.equal(r.rank, 2);
    assert.equal(r.found, 2);
    assert.equal(r.of, 2);
    assert.deepEqual(r.topDocs, ["Z", "B", "A"]);
  });

  test("no relevant chunk is a miss with a null rank", () => {
    const r = scoreCase(CASE, ranked(chunk("Z"), chunk("Y")));
    assert.equal(r.rank, null);
    assert.equal(r.found, 0);
  });

  test("recall@k, MRR and coverage summarize a set of results", () => {
    const m = summarize([
      { id: "1", category: "x", rank: 1, found: 1, of: 1, topDocs: [] },
      { id: "2", category: "x", rank: 4, found: 1, of: 2, topDocs: [] },
      { id: "3", category: "y", rank: null, found: 0, of: 1, topDocs: [] },
      { id: "4", category: "y", rank: 12, found: 1, of: 1, topDocs: [] },
    ]);
    assert.equal(m.cases, 4);
    assert.equal(m.recallAt[1], 0.25);
    assert.equal(m.recallAt[5], 0.5);
    assert.equal(m.recallAt[15], 0.75);
    assert.ok(Math.abs(m.mrr - (1 + 0.25 + 0 + 1 / 12) / 4) < 1e-9);
    assert.equal(m.coverage, (1 + 0.5 + 0 + 1) / 4);
  });

  test("results break down by category", () => {
    const groups = byCategory([
      { id: "1", category: "x", rank: 1, found: 1, of: 1, topDocs: [] },
      { id: "2", category: "y", rank: null, found: 0, of: 1, topDocs: [] },
    ]);
    assert.equal(groups.x.recallAt[5], 1);
    assert.equal(groups.y.recallAt[5], 0);
  });

  test("an empty run has zero metrics, not NaN", () => {
    const m = summarize([]);
    assert.equal(m.mrr, 0);
    assert.equal(m.recallAt[5], 0);
  });
});

describe("regression check", () => {
  const base: Metrics = { cases: 10, recallAt: { 1: 0.5, 3: 0.7, 5: 0.8, 10: 0.9, 15: 0.9 }, mrr: 0.7, coverage: 0.9 };

  test("equal or better passes; a drop beyond the tolerance fails and names the metric", () => {
    assert.ok(compareToBaseline(base, base).ok);
    assert.ok(compareToBaseline({ ...base, recallAt: { ...base.recallAt, 5: 0.79 } }, base).ok);
    const worse = compareToBaseline({ ...base, recallAt: { ...base.recallAt, 5: 0.6 }, mrr: 0.5 }, base);
    assert.equal(worse.ok, false);
    assert.ok(worse.failures.some((f) => f.startsWith("Recall@5")));
    assert.ok(worse.failures.some((f) => f.startsWith("MRR")));
  });
});

describe("gold set", () => {
  const gold: BenchmarkCase[] = JSON.parse(readFileSync("benchmarks/retrieval/gold.json", "utf8"));

  test("is well formed: unique ids, questions, relevant passages, valid patterns", () => {
    assert.deepEqual(validateCases(gold), []);
    assert.ok(gold.length >= 40);
  });

  test("validateCases reports duplicates, empty relevance and bad patterns", () => {
    const bad: BenchmarkCase[] = [
      { id: "a", category: "t", question: "q", relevant: [] },
      { id: "a", category: "t", question: "q", relevant: [{ doc: "D", heading: "(" }] },
    ];
    const problems = validateCases(bad).join("\n");
    assert.match(problems, /duplicate case id a/);
    assert.match(problems, /no relevant passages/);
    assert.match(problems, /bad heading pattern/);
  });
});

describe("real corpus benchmark", { skip: SKIP_WITHOUT_CORPUS }, () => {
  const gold: BenchmarkCase[] = JSON.parse(readFileSync("benchmarks/retrieval/gold.json", "utf8"));
  const baseline = JSON.parse(readFileSync("benchmarks/retrieval/baseline.json", "utf8")) as { raw: Metrics };
  const { index } = buildGovernedIndex(ingestContentRepository("Content Repository").chunks);

  test("every relevant passage in the gold set resolves to at least one indexed chunk", () => {
    for (const c of gold) {
      for (const p of c.relevant) {
        assert.ok(
          index.indexed.some((i) => matches(i.chunk, p)),
          `${c.id}: no indexed chunk for ${p.doc}${p.heading ? ` / ${p.heading}` : ""}`
        );
      }
    }
  });

  test("raw BM25 recall has not regressed against the committed baseline", () => {
    const results = gold.map((c) => scoreCase(c, search(index, c.question, 15)));
    const check = compareToBaseline(summarize(results), baseline.raw);
    assert.ok(check.ok, check.failures.join("; "));
  });
});
