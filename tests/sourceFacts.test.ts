import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { formatSourceDate, parseSourceDate, sourceFactsLine, sourceFactsLog, sourceFactsOf } from "../lib/governance/sourceFacts.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";

function chunk(over: Partial<Chunk> = {}): Chunk {
  return { id: "d::s0", documentId: "RKC-000041", documentTitle: "Trending This Week", heading: null, text: "Body text.", citationUrl: null, citationUrlType: null, ...over };
}

describe("parseSourceDate", () => {
  it("reads the corpus's date shapes", () => {
    assert.equal(parseSourceDate("2026-04-16 14:55:28 UTC"), "2026-04-16");
    assert.equal(parseSourceDate("Jul 4, 2024"), "2024-07-04");
    assert.equal(parseSourceDate("Jan 16, 2026"), "2026-01-16");
    assert.equal(parseSourceDate("14/7/26"), "2026-07-14");
    assert.equal(parseSourceDate("16/04/2026"), "2026-04-16");
  });
  it("leaves out dates it cannot read unambiguously", () => {
    assert.equal(parseSourceDate("07/14/26"), null); // month above 12: not day/month/year
    assert.equal(parseSourceDate("31/2/26"), null);
    assert.equal(parseSourceDate("soon"), null);
    assert.equal(parseSourceDate(""), null);
    assert.equal(parseSourceDate(undefined), null);
  });
  it("formats for the prompt", () => {
    assert.equal(formatSourceDate("2026-07-14"), "14 Jul 2026");
  });
});

describe("source facts", () => {
  const registered = { status: "registered" as const, contentType: "Newsletter", collection: "Trending This Week", sourceModified: "14/7/26" };

  it("prefers the document's own date over the registry's", () => {
    const f = sourceFactsOf(chunk({ documentDate: "Jul 6, 2026", governance: registered }));
    assert.deepEqual(f.date, { iso: "2026-07-06", basis: "document" });
  });
  it("falls back to the registry modified date", () => {
    const f = sourceFactsOf(chunk({ governance: registered }));
    assert.deepEqual(f.date, { iso: "2026-07-14", basis: "registry" });
  });
  it("labels type, collection and date", () => {
    assert.equal(sourceFactsLine(chunk({ governance: registered })), "Type: Newsletter (Trending This Week) | Updated: 14 Jul 2026");
  });
  it("says nothing for an unregistered file with no date, and never invents one", () => {
    assert.equal(sourceFactsLine(chunk({ governance: { status: "unregistered" } })), "");
    assert.equal(sourceFactsLine(chunk()), "");
  });
  it("logs the same facts plus where the date came from", () => {
    assert.deepEqual(sourceFactsLog(chunk({ governance: registered })), { contentType: "Newsletter", collection: "Trending This Week", updated: "2026-07-14", updatedBasis: "registry" });
  });
});

describe("source labels in the prompt", () => {
  it("adds the label line under the source header and leaves unlabeled sources unchanged", () => {
    const labeled = chunk({ governance: { status: "registered", contentType: "Training", sourceModified: "9/6/26" } });
    const plain = chunk({ id: "e::s0", documentId: "pricing", documentTitle: "Pricing Playbook" });
    const prompt = buildPrompt("q", [
      { chunk: labeled, score: 2 },
      { chunk: plain, score: 1 },
    ]);
    assert.match(prompt, /\[Source 1\] Trending This Week\nType: Training \| Updated: 9 Jun 2026\nBody text\./);
    assert.match(prompt, /\[Source 2\] Pricing Playbook\nBody text\./);
  });
  it("does not rank: order and content of sources are untouched by labels", () => {
    const a = chunk({ governance: { status: "registered", contentType: "Newsletter" } });
    const b = chunk({ id: "x::s0", documentTitle: "Training X", governance: { status: "registered", contentType: "Training" } });
    const prompt = buildPrompt("q", [{ chunk: a, score: 1 }, { chunk: b, score: 2 }]);
    assert.ok(prompt.indexOf("[Source 1] Trending This Week") < prompt.indexOf("[Source 2] Training X"));
  });
});
