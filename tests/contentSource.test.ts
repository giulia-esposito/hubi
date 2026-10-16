import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  downloadSupportedObjects,
  MAX_FILE_BYTES,
  LARGE_FILE_WARN_BYTES,
  type GcsFileLike,
} from "../lib/ingestion/contentSource.ts";

/**
 * Fake GCS object. Exposes only createReadStream(), and also carries a
 * download() that fails the test: the old full-buffer path must never be used.
 */
function fakeFile(name: string, size: number, streamed: string[], chunks?: Buffer[]): GcsFileLike {
  return Object.assign(
    {
      name,
      metadata: { size: String(size) },
      createReadStream: () => {
        streamed.push(name);
        return Readable.from(chunks ?? [Buffer.from(`content of ${name}`)]);
      },
    },
    {
      download: async () => {
        throw new Error(`download() must not be used (called for ${name})`);
      },
    }
  );
}

const bucketOf = (files: GcsFileLike[]) => ({ getFiles: async () => [files] as [GcsFileLike[]] });

describe("downloadSupportedObjects", () => {
  let dest: string;
  let streamed: string[];
  let logs: string[];
  const log = (m: string) => logs.push(m);

  beforeEach(() => {
    dest = mkdtempSync(path.join(os.tmpdir(), "hubi-cs-test-"));
    streamed = [];
    logs = [];
  });
  afterEach(() => rmSync(dest, { recursive: true, force: true }));

  test("never opens a read stream for unsupported objects", async () => {
    const files = [
      fakeFile("repo/a.docx", 10, streamed),
      fakeFile("repo/video.mp4", 5_000_000_000, streamed),
      fakeFile("repo/export.zip", 1000, streamed),
      fakeFile("repo/logo.png", 100, streamed),
      fakeFile("repo/photo.JPG", 100, streamed),
      fakeFile("repo/deck.PPTX", 10, streamed),
    ];
    const summary = await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(streamed, ["repo/a.docx", "repo/deck.PPTX"]);
    for (const unsupported of ["video.mp4", "export.zip", "logo.png", "photo.JPG"]) {
      assert.equal(existsSync(path.join(dest, unsupported)), false);
    }
    assert.equal(summary.downloaded, 2);
    assert.equal(summary.skippedUnsupported, 4);
    assert.deepEqual(summary.skippedUnsupportedByExtension, { ".mp4": 1, ".zip": 1, ".png": 1, ".jpg": 1 });
  });

  test("streams supported objects to disk without the full-buffer download() path", async () => {
    const chunks = [Buffer.from("part-1|"), Buffer.from("part-2|"), Buffer.from("part-3")];
    const files = [fakeFile("repo/deck.pptx", 21, streamed, chunks)];
    await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(streamed, ["repo/deck.pptx"]);
    assert.equal(readFileSync(path.join(dest, "deck.pptx"), "utf8"), "part-1|part-2|part-3");
  });

  test("preserves nested paths and strips the prefix", async () => {
    const files = [fakeFile("repo/Folder/Sub/a.docx", 10, streamed)];
    await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.equal(readFileSync(path.join(dest, "Folder", "Sub", "a.docx"), "utf8"), "content of repo/Folder/Sub/a.docx");
  });

  test("skips directory placeholder objects", async () => {
    const files = [fakeFile("repo/", 0, streamed), fakeFile("repo/Folder/", 0, streamed), fakeFile("repo/a.docx", 1, streamed)];
    const summary = await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(streamed, ["repo/a.docx"]);
    assert.equal(summary.skippedUnsupported, 0);
  });

  test("throws when no objects exist under the prefix", async () => {
    await assert.rejects(downloadSupportedObjects(bucketOf([]), "b", "repo", dest, log), /No objects found/);
  });

  test("throws when objects exist but none are supported, without opening any stream", async () => {
    const files = [fakeFile("repo/v.mp4", 10, streamed)];
    await assert.rejects(downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log), /none are supported/);
    assert.deepEqual(streamed, []);
  });

  test("skips supported files above the size limit without streaming them", async () => {
    const files = [fakeFile("repo/huge.pptx", MAX_FILE_BYTES + 1, streamed), fakeFile("repo/ok.docx", 10, streamed)];
    const summary = await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(streamed, ["repo/ok.docx"]);
    assert.deepEqual(summary.skippedOversized, ["huge.pptx"]);
    assert.equal(existsSync(path.join(dest, "huge.pptx")), false);
  });

  test("still downloads large supported files and names them in the plan log", async () => {
    const files = [fakeFile("repo/big.pptx", LARGE_FILE_WARN_BYTES, streamed)];
    await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);
    assert.deepEqual(streamed, ["repo/big.pptx"]);
    assert.match(logs[0], /large: big\.pptx \(50\.0 MiB\)/);
  });

  test("logs the aggregate plan before any download begins", async () => {
    const seenAtStreamOpen: string[][] = [];
    const file = fakeFile("repo/a.docx", 1_048_576, streamed);
    const original = file.createReadStream;
    file.createReadStream = () => {
      seenAtStreamOpen.push([...logs]);
      return original();
    };
    const files = [
      file,
      fakeFile("repo/huge.pptx", MAX_FILE_BYTES + 1, streamed),
      ...Array.from({ length: 50 }, (_, i) => fakeFile(`repo/v${i}.mp4`, 1, streamed)),
    ];
    await downloadSupportedObjects(bucketOf(files), "b", "repo", dest, log);

    assert.equal(seenAtStreamOpen.length, 1);
    assert.equal(seenAtStreamOpen[0].length, 1, "exactly the plan line exists when the first stream opens");
    assert.match(seenAtStreamOpen[0][0], /Plan: 1 supported files selected \(1\.0 MiB\)/);
    assert.match(seenAtStreamOpen[0][0], /skipped 50 unsupported/);
    assert.match(seenAtStreamOpen[0][0], /skipped 1 oversized: huge\.pptx/);
    assert.equal(logs.length, 2, "one plan line plus one completion line, not one line per skipped file");
    assert.match(logs[1], /Downloaded 1 files/);
  });

  test("the plan log survives a download that fails part-way", async () => {
    const failing = fakeFile("repo/a.docx", 10, streamed);
    failing.createReadStream = () =>
      new Readable({
        read() {
          this.destroy(new Error("connection reset"));
        },
      });
    await assert.rejects(downloadSupportedObjects(bucketOf([failing]), "b", "repo", dest, log), /connection reset/);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Plan: 1 supported files selected/);
  });
});
