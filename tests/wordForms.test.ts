import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, search, wordForms } from "../lib/retrieval/index.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";

const chunk = (id: string, heading: string, text: string): Chunk => ({
  id,
  documentId: id.split("::")[0],
  documentTitle: id,
  heading,
  text,
  citationUrl: null,
  citationUrlType: "learnerUrl",
});

describe("word forms in the question", () => {
  it("gives the base and sibling forms of an inflected word, and nothing for a bare word", () => {
    assert.deepEqual(wordForms("duplicated"), ["duplicat", "duplicate", "duplicates", "duplicating"]);
    assert.deepEqual(wordForms("duplicates"), ["duplicat", "duplicate"]);
    assert.deepEqual(wordForms("merging"), ["merg", "merge", "merged", "merges"]);
    assert.deepEqual(wordForms("duplicate"), []);
    assert.deepEqual(wordForms("business"), []);
  });

  // The pilot question "What are the current duplicated rules in Salesforce?" put the playbook's duplicate section sixth, out of what the model sees.
  const fixture = [
    chunk("rules::s0", "Expected Behavior", "These are the current rules in Salesforce. The rules apply to every opportunity and the rules are reviewed."),
    chunk("rules::s1", "Rules by segment", "Rules for each segment in Salesforce are listed here; current rules change by segment."),
    chunk("rules::s2", "Rule exceptions", "Current rules in Salesforce have exceptions, and rules may differ by region."),
    chunk("play::s0", "How to create an account", "Before creating an account check that it does not already exist. Salesforce flags a duplicate account and one duplicate rule applies."),
    chunk("play::s1", "Other topic", "Unrelated pricing text about discounts."),
    chunk("play::s2", "Merging", "Merge the duplicates through a Jira request."),
  ];
  const index = buildIndex(fixture);

  it("finds passages written with another form of a rare word", () => {
    const top = search(index, "What are the current duplicated rules in Salesforce?", 5).map((r) => r.chunk.id);
    assert.ok(top.includes("play::s0"), top.join(", "));
    assert.ok(top.includes("play::s2"), top.join(", "));
  });

  it("leaves the ranking of questions with common words alone", () => {
    const withForms = search(index, "current rules in Salesforce", 4).map((r) => r.chunk.id);
    assert.deepEqual(withForms.slice(0, 3).sort(), ["rules::s0", "rules::s1", "rules::s2"]);
  });
});
