import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import type { IngestionResult } from "../lib/ingestion/ingest.ts";

describe("ingestion: real Content Repository", () => {
  let result: IngestionResult;

  before(() => {
    result = ingestContentRepository("Content Repository");
  });

  test("ingests every known document in the current Content Repository, with zero failures", () => {
    // Content Repository now includes the original 15 RKC house-template DOCX
    // files plus 5 ad hoc PMM files (3 DOCX, 2 PPTX) added directly to a
    // "PMM Files" folder outside the RKC convention -- 20 documents total.
    // A change to this number is an expected signal to review whenever a
    // document is added/removed, not a bug by itself.
    assert.equal(result.documents.length, 20);
    assert.equal(result.report.filter((r) => r.status === "failed").length, 0);
  });

  test("produces the known total chunk count for the current corpus", () => {
    assert.equal(result.chunks.length, 2103);
  });

  test("every RKC-numbered document used the house template (Document Metadata + Core Knowledge Body)", () => {
    // Only the original Revenue Knowledge Center assets are expected to
    // follow the house template -- the ad hoc PMM files deliberately don't,
    // and normalize.ts's generic fallback path is what's exercised for them.
    const rkcDocs = result.documents.filter((d) => d.id.startsWith("RKC-"));
    assert.equal(rkcDocs.length, 15);
    for (const doc of rkcDocs) {
      assert.equal(doc.usedTemplate, true, `expected ${doc.title} to use the house template`);
    }
  });

  test("every chunk has the fields required for retrieval and citation", () => {
    for (const chunk of result.chunks) {
      assert.ok(chunk.id, "chunk.id must be non-empty");
      assert.ok(chunk.documentId, "chunk.documentId must be non-empty");
      assert.ok(chunk.documentTitle, "chunk.documentTitle must be non-empty");
      assert.ok(chunk.text.trim().length > 0, "chunk.text must not be blank");
    }
  });

  test("a known document produces its expected chunk count (regression against chunking rules)", () => {
    const rkc2 = result.chunks.filter((c) => c.documentId === "RKC-000002");
    const rkc21 = result.chunks.filter((c) => c.documentId === "RKC-000021");
    assert.equal(rkc2.length, 39, "RKC-000002 (Salesloft) should produce 39 chunks");
    assert.equal(rkc21.length, 4, "RKC-000021 (Elevator Pitch) should produce 4 chunks");
  });
});
