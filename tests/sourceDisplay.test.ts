import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { groupSources, humanizeTitle } from "../lib/ui/sourceDisplay.ts";

describe("humanizeTitle", () => {
  test("drops file-name leftovers", () => {
    assert.equal(humanizeTitle("PMM _ Slide Library _ US _ DO NOT EDIT"), "PMM Slide Library US");
    assert.equal(humanizeTitle("[RKC-000020] Sales Tools Access Guide"), "Sales Tools Access Guide");
    assert.equal(humanizeTitle("Recorded Session | [Salesloft] Best Practices for Reps"), "Recorded Session · Salesloft Best Practices for Reps");
  });
  test("keeps an ordinary title and never returns an empty one", () => {
    assert.equal(humanizeTitle("Client Segmentation - Contract Adherence T3/T4"), "Client Segmentation - Contract Adherence T3/T4");
    assert.equal(humanizeTitle("DO NOT EDIT"), "DO NOT EDIT");
  });
});

describe("groupSources", () => {
  const s = (documentTitle: string, heading: string | null, citationUrl: string | null, restriction?: string) => ({ documentTitle, heading, citationUrl, restriction });
  test("one row per document with its distinct sections, in rank order", () => {
    const rows = groupSources([s("Doc A", "Intro", "https://a"), s("Doc B", null, "https://b"), s("Doc A", "Intro", "https://a"), s("Doc A", "Steps", "https://a")]);
    assert.deepEqual(rows.map((r) => r.title), ["Doc A", "Doc B"]);
    assert.deepEqual(rows[0].sections, ["Intro", "Steps"]);
  });
  test("keeps at most three sections, a link when any passage has one, and the restriction", () => {
    const rows = groupSources([s("Doc A", "1", null), s("Doc A", "2", "https://a", "Internal use only"), s("Doc A", "3", null), s("Doc A", "4", null)]);
    assert.equal(rows[0].sections.length, 3);
    assert.equal(rows[0].url, "https://a");
    assert.equal(rows[0].restriction, "Internal use only");
  });
  test("a heading that repeats the title is not shown as a section", () => {
    assert.deepEqual(groupSources([s("Doc A", "Doc A", null)])[0].sections, []);
  });
  test("no sources gives no rows", () => {
    assert.deepEqual(groupSources([]), []);
  });
});
