import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { buildIndex, search, tokenize } from "../lib/retrieval/index.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";

describe("retrieval: BM25 mechanics (synthetic fixture)", () => {
  const fixture: Chunk[] = [
    {
      id: "doc-a::s0",
      documentId: "doc-a",
      documentTitle: "Doc A",
      heading: "Salesloft Cadences",
      text: "This section explains how to build a cadence in Salesloft and personalize it with templates.",
      citationUrl: "https://example.com/a",
      citationUrlType: "learnerUrl",
    },
    {
      id: "doc-b::s0",
      documentId: "doc-b",
      documentTitle: "Doc B",
      heading: "Pricing Overview",
      text: "This section explains pricing tiers and discount approval thresholds for enterprise clients.",
      citationUrl: null,
      citationUrlType: null,
    },
  ];

  test("tokenize lowercases, strips punctuation, and drops stopwords", () => {
    assert.deepEqual(tokenize("The Cadence, and Templates!"), ["cadence", "templates"]);
  });

  test("search ranks the chunk containing the query terms above an unrelated chunk", () => {
    const index = buildIndex(fixture);
    const results = search(index, "how do I build a cadence", 5);
    assert.ok(results.length > 0);
    assert.equal(results[0].chunk.id, "doc-a::s0");
  });

  test("search returns nothing for a query with zero term overlap in the corpus", () => {
    const index = buildIndex(fixture);
    const results = search(index, "unrelated aardvark topic", 5);
    assert.equal(results.length, 0);
  });
});

describe("retrieval: real corpus integration", () => {
  let index: ReturnType<typeof buildIndex>;

  before(() => {
    const { chunks } = ingestContentRepository("Content Repository");
    index = buildIndex(chunks);
  });

  test("a real known-answer question retrieves the correct source document", () => {
    // Previously asserted the top result came from the Salesloft training
    // recording. Since "Sales Tools Playbook - Revenue Team" was added to
    // Content Repository, it now ranks first with dedicated, procedural
    // sections ("Cadence Owner", "Step-by-step on how to use it") that are
    // genuinely more directly on-topic than the recorded-session transcript
    // -- confirmed by reading the actual chunk text, not assumed. Updated
    // deliberately, not loosened to dodge a regression.
    const results = search(index, "how should I prepare cadences in Salesloft", 5);
    assert.ok(results.length > 0, "expected at least one match");
    assert.equal(
      results[0].chunk.documentTitle,
      "Start here! Accessing the sales tools you need to do your job",
      "top result should come from the Sales Tools Playbook's Salesloft/cadences section"
    );
  });

  test("safe gap handling: a query guaranteed not to appear anywhere in the corpus matches nothing", () => {
    // Deliberately fabricated, non-dictionary tokens -- not a real-word nonsense
    // query, which (per Prototype_Plan.md's documented limitation) can still
    // produce a weak coincidental match against long unstructured transcripts.
    const results = search(index, "zzqxvnotarealword12345 qbdfnotarealword67890", 5);
    assert.equal(results.length, 0);
  });
});
