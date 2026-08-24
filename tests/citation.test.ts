import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatCitation } from "../lib/runtime/citationBuilder.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";

function chunk(overrides: Partial<Chunk>): Chunk {
  return {
    id: "x::s0",
    documentId: "x",
    documentTitle: "Example Document",
    heading: null,
    text: "text",
    citationUrl: null,
    citationUrlType: null,
    ...overrides,
  };
}

describe("citationBuilder: presence of a link controls clickability, never omission", () => {
  test("renders a clickable citation when a URL is present, with heading locator", () => {
    const c = chunk({ heading: "2.1 Contract Differences", citationUrl: "https://example.com/g/abc", citationUrlType: "learnerUrl" });
    assert.equal(formatCitation(c), "Example Document -- 2.1 Contract Differences (https://example.com/g/abc)");
  });

  test("renders a non-clickable citation (never omitted) when no URL is present", () => {
    const c = chunk({ heading: "2.1 Contract Differences" });
    assert.equal(formatCitation(c), "Example Document -- 2.1 Contract Differences (no link available)");
  });

  test("falls back to the document title alone when there is no heading locator", () => {
    const c = chunk({ citationUrl: "https://example.com/g/abc" });
    assert.equal(formatCitation(c), "Example Document (https://example.com/g/abc)");
  });
});
