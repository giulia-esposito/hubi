import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_EXTENSIONS, isSupportedFile } from "../lib/ingestion/supportedFormats.ts";

describe("supportedFormats", () => {
  test("allowlist is exactly .docx and .pptx", () => {
    assert.deepEqual([...SUPPORTED_EXTENSIONS].sort(), [".docx", ".pptx"]);
  });

  test("accepts docx/pptx, case-insensitively and in nested paths", () => {
    assert.equal(isSupportedFile("a.docx"), true);
    assert.equal(isSupportedFile("a.PPTX"), true);
    assert.equal(isSupportedFile("PMM Files/[RKC-000001] Doc.DocX"), true);
  });

  test("rejects media, archives, other documents and extensionless names", () => {
    for (const name of ["v.mp4", "v.MOV", "x.zip", "x.pdf", "x.xlsx", "README", "a.docx.bak", "a.doc", "folder/"]) {
      assert.equal(isSupportedFile(name), false, name);
    }
  });
});
