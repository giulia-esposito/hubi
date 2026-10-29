import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { detectSourceGovernance, sourceGovernanceNotice } from "../lib/governance/sourceGovernance.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";

function src(id: string, contentType: string | undefined, collection: string, date: string): { chunk: Chunk; score: number } {
  return {
    score: 1,
    chunk: {
      id: `${id}::s0`,
      documentId: id,
      documentTitle: id,
      heading: null,
      text: "text",
      citationUrl: null,
      citationUrlType: null,
      documentDate: date,
      governance: contentType ? { status: "registered", contentType, collection } : { status: "unregistered" },
    },
  };
}

describe("source-governance detection", () => {
  it("fires when an update-type and a process-type source are mixed, and lists both", () => {
    const s = detectSourceGovernance([src("a", "Training", "Sales Methodology", "Mar 2, 2026"), src("b", "Newsletter", "Trending This Week", "Jul 14, 2026")]);
    assert.deepEqual(s, { reason: "update-and-process", sources: [1, 2] });
  });
  it("treats the Trending This Week collection as updates even when typed Wiki Page", () => {
    const s = detectSourceGovernance([src("a", "Training", "Contracts", "Mar 2, 2026"), src("b", "Wiki Page", "Trending This Week", "Jul 14, 2026")]);
    assert.equal(s?.reason, "update-and-process");
  });
  it("fires for one family written at least 30 days apart, not for close dates or different families", () => {
    assert.equal(detectSourceGovernance([src("a", "Training", "Contracts", "Jan 5, 2026"), src("b", "Training", "Contracts", "Jul 14, 2026")])?.reason, "same-family-different-dates");
    assert.equal(detectSourceGovernance([src("a", "Training", "Contracts", "Jul 1, 2026"), src("b", "Training", "Contracts", "Jul 14, 2026")]), null);
    assert.equal(detectSourceGovernance([src("a", "Training", "Contracts", "Jan 5, 2026"), src("b", "Training", "Revenue Tools", "Jul 14, 2026")]), null);
  });
  it("stays quiet for a single document, several updates only, or unregistered sources", () => {
    assert.equal(detectSourceGovernance([src("a", "Newsletter", "Trending This Week", "Jul 7, 2026"), src("b", "Newsletter", "Trending This Week", "Jul 14, 2026")]), null);
    assert.equal(detectSourceGovernance([{ ...src("a", "Training", "Contracts", "Mar 2, 2026") }, { ...src("a", "Training", "Contracts", "Mar 2, 2026") }]), null);
    assert.equal(detectSourceGovernance([src("a", undefined, "", ""), src("b", "Newsletter", "Trending This Week", "Jul 14, 2026")]), null);
  });
});

describe("source-governance notice", () => {
  it("states the approved rule and does not penalise newsletters or prefer newer sources", () => {
    const n = sourceGovernanceNotice({ reason: "update-and-process", sources: [1, 2] });
    assert.match(n, /If they agree, answer normally/);
    assert.match(n, /Do not prefer a source just because it is newer/);
    assert.match(n, /not.*less reliable just because it is a newsletter/);
    assert.match(n, /explicitly updates, replaces, overrides or supersedes/);
    assert.match(n, /say plainly that the guidance changed/);
    assert.match(n, /do not present either as the authoritative one/);
    assert.match(n, /only announces a training/);
  });
  it("is added to the prompt only when the signal fires", () => {
    const mixed = buildPrompt("q", [src("a", "Training", "Contracts", "Mar 2, 2026"), src("b", "Newsletter", "Trending This Week", "Jul 14, 2026")]);
    assert.match(mixed, /\[Source notice\] Sources 1, 2/);
    const single = buildPrompt("q", [src("a", "Training", "Contracts", "Mar 2, 2026")]);
    assert.doesNotMatch(single, /\[Source notice\]/);
  });
});
