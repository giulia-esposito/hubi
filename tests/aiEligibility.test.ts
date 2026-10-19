import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { AI_ELIGIBILITY_EXCLUSIONS, excludeIneligible } from "../lib/governance/aiEligibility.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import { search } from "../lib/retrieval/index.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";
import { applyApplicability } from "../lib/applicability/evaluate.ts";
import { createRegionVocabulary, detectTaskRegions } from "../lib/applicability/regions.ts";
import { formatCitation } from "../lib/runtime/citationBuilder.ts";

// AI Eligibility is a governance gate, not a retrieval optimization: content
// known to be Not Eligible must never reach retrieval, prompts, citations or
// logs. Deterministic; no model call.

function chunk(documentId: string, id: string): Chunk {
  return { id, documentId, documentTitle: documentId, heading: null, text: `text ${id}`, citationUrl: null, citationUrlType: null };
}

describe("AI Eligibility deny-list", () => {
  test("RKC-000021 (Not Eligible in the registry) is on the list, with its source recorded", () => {
    const entry = AI_ELIGIBILITY_EXCLUSIONS.find((e) => e.contentId === "RKC-000021");
    assert.ok(entry);
    assert.equal(entry.aiEligibility, "Not Eligible");
    assert.match(entry.source, /Content Registry/);
    assert.match(entry.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("excludeIneligible removes every chunk of an excluded document and reports what it removed", () => {
    const chunks = [chunk("RKC-000021", "a"), chunk("RKC-000002", "b"), chunk("RKC-000021", "c")];
    const result = excludeIneligible(chunks);
    assert.deepEqual(result.chunks.map((c) => c.id), ["b"]);
    assert.deepEqual(result.excluded, [{ contentId: "RKC-000021", aiEligibility: "Not Eligible", chunkCount: 2 }]);
  });

  test("Pending Assessment entries are excluded the same way", () => {
    const result = excludeIneligible([chunk("RKC-000099", "x"), chunk("RKC-000002", "y")], [
      { contentId: "RKC-000099", aiEligibility: "Pending Assessment", source: "test", recordedAt: "2026-01-01" },
    ]);
    assert.deepEqual(result.chunks.map((c) => c.id), ["y"]);
  });

  test("content not on the list is untouched", () => {
    const chunks = [chunk("RKC-000002", "a"), chunk("RKC-000006", "b")];
    assert.deepEqual(excludeIneligible(chunks).chunks, chunks);
    assert.deepEqual(excludeIneligible(chunks).excluded, []);
  });
});

describe("real corpus: Not Eligible content never reaches retrieval or reasoning", () => {
  const { chunks } = ingestContentRepository("Content Repository");
  const rkc21 = chunks.filter((c) => c.documentId === "RKC-000021");
  const { index, excluded } = buildGovernedIndex(chunks);

  test("raw ingestion is still a full inventory, and the governed index drops exactly RKC-000021", () => {
    assert.equal(rkc21.length, 4);
    assert.equal(index.n, chunks.length - rkc21.length);
    assert.deepEqual(excluded, [{ contentId: "RKC-000021", aiEligibility: "Not Eligible", chunkCount: 4 }]);
    assert.ok(index.indexed.every((i) => i.chunk.documentId !== "RKC-000021"));
  });

  test("hard pass/fail: RKC-000021 is not retrievable under any query, including ones that name it", () => {
    const queries = [
      "How can I present Wellhub to a prospect? Write a 1-min elevator pitch.",
      "Write me an elevator pitch.",
      "Do we have an elevator pitch?",
      'RKO 2026 "What is Wellhub" Elevator Pitch Submission',
      "elevator pitch scorecard",
      "#1 superpower engagement didn't have a gym corporate wellbeing solution",
      "Submit your elevator pitch for the RKO 2026 challenge",
      ...rkc21.map((c) => c.text.slice(0, 200)),
      ...rkc21.map((c) => c.heading ?? ""),
    ];
    for (const q of queries) {
      for (const r of search(index, q, 50)) assert.notEqual(r.chunk.documentId, "RKC-000021", `retrieved for: ${q.slice(0, 60)}`);
    }
  });

  test("none of its text can reach a prompt or a citation", () => {
    const vocab = createRegionVocabulary(null);
    const q = "How can I present Wellhub to a prospect? Write a 1-min elevator pitch.";
    const ranked = search(index, q, 15);
    const decision = applyApplicability(detectTaskRegions(vocab, [q]), ranked, 5);
    const prompt = buildPrompt(q, decision.eligible, [], decision).replace(/\s+/g, " ");
    const citations = decision.eligible.map((r) => formatCitation(r.chunk)).join("\n");
    for (const c of rkc21) {
      const sample = c.text.replace(/\s+/g, " ").trim().slice(0, 80);
      assert.ok(!prompt.includes(sample), `prompt contains excluded text: ${sample}`);
    }
    assert.ok(!citations.includes("RKC-000021"));
    assert.ok(!/What is Wellhub"? Elevator Pitch Submission/.test(citations));
  });
});
