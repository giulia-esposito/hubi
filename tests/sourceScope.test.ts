import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { scopeLimitsOf, scopeLine, scopeNotice, scopedSources } from "../lib/governance/sourceScope.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";

function src(id: string, audience: string[] | undefined, restriction?: string): { chunk: Chunk; score: number } {
  return { score: 1, chunk: { id: `${id}::s0`, documentId: id, documentTitle: id, heading: null, text: "text " + id, citationUrl: null, citationUrlType: null, audience, governance: { status: "registered", restriction } } };
}

describe("scope limits", () => {
  it("names a registry restriction and an audience of one or two groups as limits", () => {
    assert.deepEqual(scopeLimitsOf(src("a", ["Sales ENT"]).chunk), ["written for Sales ENT only"]);
    assert.deepEqual(scopeLimitsOf(src("a", ["Sales", "CS"]).chunk), ["written for Sales and CS only"]);
    assert.deepEqual(scopeLimitsOf(src("a", undefined, "Only released for US").chunk), ["registry restriction: Only released for US"]);
  });
  it("does not limit a source written for three or more groups, for everyone, or with no audience", () => {
    assert.deepEqual(scopeLimitsOf(src("a", ["Sales", "Sales Dev", "CS"]).chunk), []);
    assert.deepEqual(scopeLimitsOf(src("a", ["Revenue"]).chunk), []);
    assert.deepEqual(scopeLimitsOf(src("a", ["[GLOBAL]"]).chunk), []);
    assert.deepEqual(scopeLimitsOf(src("a", undefined).chunk), []);
  });
  it("lists only the limited sources, numbered as in the prompt", () => {
    const s = scopedSources([src("a", undefined), src("b", ["Channel partners"]), src("c", ["Sales", "CS", "WE"]), src("d", undefined, "US only")]);
    assert.deepEqual(s.map((x) => x.source), [2, 4]);
    assert.equal(scopeLine(src("b", ["Channel partners"]).chunk), "Scope: written for Channel partners only");
  });
});

describe("scope notice", () => {
  it("separates general from conditional guidance, presents alternatives, and states the covered situation", () => {
    const n = scopeNotice([{ source: 2, limits: ["written for Channel partners only"] }]);
    assert.match(n, /Sources 2 carry a "Scope" line/);
    assert.match(n, /First the general guidance, from sources without a limit only/);
    assert.match(n, /Never put limited content in the numbered steps/);
    assert.match(n, /each one under its own clearly labelled heading/);
    assert.match(n, /Write the answer in two parts/);
    assert.match(n, /Only for specific situations/);
    assert.match(n, /say at the start which situation your answer covers/);
    assert.match(n, /not fully implemented/);
  });
  it("appears in the prompt, with the Scope line under the source, only when a source is limited", () => {
    const limited = buildPrompt("q", [src("a", undefined), src("b", ["Channel partners"])]);
    assert.match(limited, /\[Source 2\] b\nScope: written for Channel partners only/);
    assert.match(limited, /\[Scope notice\] Sources 2/);
    const general = buildPrompt("q", [src("a", undefined), src("c", ["Sales", "CS", "WE"])]);
    assert.doesNotMatch(general, /\[Scope notice\]/);
    assert.doesNotMatch(general, /Scope: /);
  });
});
