import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  downloadSupportedObjects,
  MAX_FILE_BYTES,
  LARGE_FILE_WARN_BYTES,
  type GcsFileLike,
} from "../lib/ingestion/contentSource.ts";

function fakeFile(name: string, size: number, downloaded: string[]): GcsFileLike {
  return {
    name,
    metadata: { size: String(size) },
    download: async () => {
      downloaded.push(name);
      return [Buffer.from(`content of ${name}`)];
    },
  };
}

const bucketOf = (files: GcsFileLike[]) => ({ getFiles: async () => [files] as [GcsFileLike[]] });

describe("downloadSupportedObjects", () => {
  let dest: string;
  let downloaded: string[];
  let logs: string[];
  const log = (m: string) => logs.push(m);

  beforeEach(() => {
    dest = mkdtempSync(path.join(os.tmpdir(), "hubi-cs-test-"));
    downloaded = [];
    logs = [];
  });
  afterEach(() => rmSync(dest, { recursive: true, force: true }));

  test("never calls download() for unsupported objects", async () => {
    const files = [
      fakeFile("repo/a.docx", 10, downloaded),
      fakeFile("repo/video.mp4", 5_000_000_000, downloaded),
      fakeFile("repo/export.zip", 1000, downloaded),
      fakeFile("repo/logo.png", 100, downloaded),
      fakeFile("repo/photo.JPG", 100, downloaded),
      fakeFile("repo/deck.PPTX", 10, downloaded),
    ];
    const summary = await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(downloaded, ["repo/a.docx", "repo/deck.PPTX"]);
    assert.equal(summary.downloaded, 2);
    assert.equal(summary.skippedUnsupported, 4);
    assert.deepEqual(summary.skippedUnsupportedByExtension, { ".mp4": 1, ".zip": 1, ".png": 1, ".jpg": 1 });
  });

  test("preserves nested paths and strips the prefix", async () => {
    const files = [fakeFile("repo/Folder/Sub/a.docx", 10, downloaded)];
    await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.equal(readFileSync(path.join(dest, "Folder", "Sub", "a.docx"), "utf8"), "content of repo/Folder/Sub/a.docx");
  });

  test("skips directory placeholder objects", async () => {
    const files = [fakeFile("repo/", 0, downloaded), fakeFile("repo/Folder/", 0, downloaded), fakeFile("repo/a.docx", 1, downloaded)];
    const summary = await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(downloaded, ["repo/a.docx"]);
    assert.equal(summary.skippedUnsupported, 0);
  });

  test("throws when no objects exist under the prefix", async () => {
    await assert.rejects(downloadSupportedObjects(bucketOf([]), "b", "repo", dest, log), /No objects found/);
  });

  test("throws when objects exist but none are supported", async () => {
    const files = [fakeFile("repo/v.mp4", 10, downloaded)];
    await assert.rejects(downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log), /none are supported/);
    assert.deepEqual(downloaded, []);
  });

  test("skips supported files above the size limit without downloading them", async () => {
    const files = [fakeFile("repo/huge.pptx", MAX_FILE_BYTES + 1, downloaded), fakeFile("repo/ok.docx", 10, downloaded)];
    const summary = await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(downloaded, ["repo/ok.docx"]);
    assert.deepEqual(summary.skippedOversized, ["huge.pptx"]);
    assert.equal(existsSync(path.join(dest, "huge.pptx")), false);
  });

  test("warns about, but still downloads, large supported files", async () => {
    const files = [fakeFile("repo/big.pptx", LARGE_FILE_WARN_BYTES, downloaded)];
    await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(downloaded, ["repo/big.pptx"]);
    assert.ok(logs.some((l) => l.includes("Warning") && l.includes("big.pptx")));
  });

  test("logs a single aggregate summary, not one line per skipped file", async () => {
    const files = [fakeFile("repo/a.docx", 1, downloaded), ...Array.from({ length: 50 }, (_, i) => fakeFile(`repo/v${i}.mp4`, 1, downloaded))];
    await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Downloaded 1 files.*skipped 50 unsupported/);
  });
});
