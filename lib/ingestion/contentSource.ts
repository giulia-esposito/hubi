import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
 * Cloud Run / GCS mode (HUBI_CONTENT_SOURCE=gcs): downloads every object
 * under gs://HUBI_GCS_BUCKET/HUBI_GCS_PREFIX into an ephemeral temp
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
  const bucket = storage.bucket(bucketName);

  const destDir = mkdtempSync(path.join(os.tmpdir(), "hubi-content-repository-"));
  const [files] = await bucket.getFiles({ prefix });

  if (files.length === 0) {
    throw new Error(
      `No objects found under gs://${bucketName}/${prefix} -- has the Content Repository been uploaded? See docs/gcp-deployment-guide.md.`
    );
  }

  for (const file of files) {
    const relative = prefix ? file.name.slice(prefix.length).replace(/^\/+/, "") : file.name;
    if (!relative || relative.endsWith("/")) continue; // skip "directory placeholder" objects

    const destPath = path.join(destDir, relative);
    await mkdir(path.dirname(destPath), { recursive: true });
    const [contents] = await file.download();
    await writeFile(destPath, contents);
  }

  return destDir;
}
