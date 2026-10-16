import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SUPPORTED_EXTENSIONS, isSupportedFile } from "./supportedFormats.ts";

/**
 * Resolves where the Content Repository (the ~2GB local export of the
 * Revenue Knowledge Center -- see Architecture.md Section 6/15) should be
 * read from, and -- for the GCS case -- fetches it into a local temp
 * directory once per process so the rest of the ingestion pipeline
 * (lib/ingestion/ingest.ts) never needs to know the difference. This is the
 * smallest viable implementation for the pilot, not a general sync/caching
 * layer: see docs/gcp-deployment-guide.md "Knowledge files" for the
 * trade-offs this accepts and what a later iteration should improve.
 *
 * Local development default (HUBI_CONTENT_SOURCE unset or "local"): reads
 * directly from the local "Content Repository" folder, exactly as before
 * this migration. No GCS credentials, bucket, or network access are
 * required to run Hubi locally -- this is a deliberate constraint (a
 * developer should never be forced onto GCS just to run the app).
 *
 * Cloud Run / GCS mode (HUBI_CONTENT_SOURCE=gcs): downloads every supported
 * (.docx/.pptx) object under gs://HUBI_GCS_BUCKET/HUBI_GCS_PREFIX into an ephemeral temp
 * directory on first use, using Application Default Credentials -- on
 * Cloud Run, that's the service's attached identity; no key file involved.
 * Cached for the lifetime of the process (module-level singleton, same
 * pattern as lib/runtime/knowledgeBase.ts), not per request.
 */
const LOCAL_DEFAULT_PATH = "Content Repository";

let cachedGcsPath: Promise<string> | null = null;

export function contentSourceMode(): "local" | "gcs" {
  const raw = process.env.HUBI_CONTENT_SOURCE?.trim().toLowerCase();
  return raw === "gcs" ? "gcs" : "local";
}

export async function resolveContentRepositoryPath(): Promise<string> {
  if (contentSourceMode() === "local") {
    return process.env.HUBI_CONTENT_REPOSITORY_PATH?.trim() || LOCAL_DEFAULT_PATH;
  }

  if (!cachedGcsPath) {
    cachedGcsPath = downloadFromGcs();
  }
  return cachedGcsPath;
}

async function downloadFromGcs(): Promise<string> {
  const bucketName = process.env.HUBI_GCS_BUCKET?.trim();
  if (!bucketName) {
    throw new Error(
      "HUBI_CONTENT_SOURCE=gcs is set but HUBI_GCS_BUCKET is missing -- see docs/gcp-deployment-guide.md."
    );
  }
  const prefix = process.env.HUBI_GCS_PREFIX?.trim() ?? "";

  // Dynamically imported so @google-cloud/storage is never required to be
  // resolvable when running locally with the default "local" mode.
  const { Storage } = await import("@google-cloud/storage");
  const storage = new Storage();
  const bucket = storage.bucket(bucketName) as unknown as GcsBucketLike;

  const destDir = mkdtempSync(path.join(os.tmpdir(), "hubi-content-repository-"));
  await downloadSupportedObjects(bucket, bucketName, prefix, destDir);
  return destDir;
}

/** Supported Office files at or above this size are downloaded but flagged. */
export const LARGE_FILE_WARN_BYTES = 50 * 1024 * 1024;
/**
 * Supported Office files above this size are skipped (and reported), not
 * downloaded: each one is buffered whole in memory and, on Cloud Run, /tmp is
 * memory-backed. Sized above the largest known real document (~191 MiB slide
 * library) so no current content is dropped.
 */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

export type ObjectAction = "skip-placeholder" | "skip-unsupported" | "skip-oversized" | "download";

/**
 * Decides what to do with one listed object from its name and metadata size
 * alone. Used by the downloader and by scripts/dry-run-content-source.ts so
 * the dry run can never drift from the real behavior.
 */
export function planObject(name: string, prefix: string, size: number): { relative: string; action: ObjectAction } {
  const relative = prefix ? name.slice(prefix.length).replace(/^\/+/, "") : name;
  if (!relative || relative.endsWith("/")) return { relative, action: "skip-placeholder" };
  if (!isSupportedFile(relative)) return { relative, action: "skip-unsupported" };
  if (size > MAX_FILE_BYTES) return { relative, action: "skip-oversized" };
  return { relative, action: "download" };
}

/** The subset of a GCS bucket/file that the downloader needs (eases testing). */
export interface GcsFileLike {
  name: string;
  metadata?: { size?: string | number };
  download(): Promise<[Buffer]>;
}
export interface GcsBucketLike {
  getFiles(options: { prefix: string }): Promise<[GcsFileLike[], ...unknown[]]>;
}

export interface DownloadSummary {
  downloaded: number;
  downloadedBytes: number;
  skippedUnsupported: number;
  skippedUnsupportedBytes: number;
  skippedUnsupportedByExtension: Record<string, number>;
  skippedOversized: string[];
}

/**
 * Downloads only ingestible files (see supportedFormats.ts) from the bucket
 * into destDir, preserving the nested path relative to the prefix.
 * Unsupported objects are filtered on their name BEFORE download() so media
 * is never pulled into memory.
 */
export async function downloadSupportedObjects(
  bucket: GcsBucketLike,
  bucketName: string,
  prefix: string,
  destDir: string,
  log: (message: string) => void = console.log
): Promise<DownloadSummary> {
  const [files] = await bucket.getFiles({ prefix });

  if (files.length === 0) {
    throw new Error(
      `No objects found under gs://${bucketName}/${prefix} -- has the Content Repository been uploaded? See docs/gcp-deployment-guide.md.`
    );
  }

  const summary: DownloadSummary = {
    downloaded: 0,
    downloadedBytes: 0,
    skippedUnsupported: 0,
    skippedUnsupportedBytes: 0,
    skippedUnsupportedByExtension: {},
    skippedOversized: [],
  };

  for (const file of files) {
    const size = Number(file.metadata?.size ?? 0);
    const { relative, action } = planObject(file.name, prefix, size);
    if (action === "skip-placeholder") continue;

    if (action === "skip-unsupported") {
      const ext = path.extname(relative).toLowerCase() || "(none)";
      summary.skippedUnsupported++;
      summary.skippedUnsupportedBytes += size;
      summary.skippedUnsupportedByExtension[ext] = (summary.skippedUnsupportedByExtension[ext] ?? 0) + 1;
      continue;
    }

    if (action === "skip-oversized") {
      summary.skippedOversized.push(relative);
      log(`[contentSource] Skipping ${relative}: ${formatMiB(size)} exceeds the ${formatMiB(MAX_FILE_BYTES)} per-file limit.`);
      continue;
    }
    if (size >= LARGE_FILE_WARN_BYTES) {
      log(`[contentSource] Warning: ${relative} is large (${formatMiB(size)}).`);
    }

    const destPath = path.join(destDir, relative);
    await mkdir(path.dirname(destPath), { recursive: true });
    const [contents] = await file.download();
    await writeFile(destPath, contents);
    summary.downloaded++;
    summary.downloadedBytes += size;
  }

  if (summary.downloaded === 0) {
    throw new Error(
      `Objects exist under gs://${bucketName}/${prefix} but none are supported (${[...SUPPORTED_EXTENSIONS].join(", ")}) or within the size limit -- check the Content Repository sync.`
    );
  }

  log(
    `[contentSource] Downloaded ${summary.downloaded} files (${formatMiB(summary.downloadedBytes)}); ` +
      `skipped ${summary.skippedUnsupported} unsupported (${formatMiB(summary.skippedUnsupportedBytes)}, ` +
      `by extension: ${JSON.stringify(summary.skippedUnsupportedByExtension)}); ` +
      `skipped ${summary.skippedOversized.length} oversized.`
  );
  return summary;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
