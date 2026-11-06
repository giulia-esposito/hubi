import { gunzipSync, gzipSync } from "node:zlib";
import type { Chunk } from "./chunk.ts";
import { openGcsBucket, planObject } from "./contentSource.ts";

/**
 * A prepared copy of the corpus: the chunks that ingestion produces, stored in the bucket next to the documents.
 *
 * Why: reading the source files (about 2 GB of mostly slide images) takes minutes on a small Cloud Run instance, and
 * every new instance would repeat it. The chunks are a few MB. The snapshot is a derived serving artifact, not a
 * second source of truth: it records exactly which source objects it was built from, and the service uses it only when
 * the bucket still holds exactly those objects. If anyone adds, replaces or removes a document without rebuilding the
 * snapshot, the service falls back to reading the files, so it can be slow but never stale.
 *
 * Governance is not part of the snapshot: the registry gate runs on the chunks at start, as before.
 */

/** Bump when ingestion changes what it produces (parsers, titles, chunking), so older snapshots are ignored. */
export const SNAPSHOT_VERSION = 1;

const SNAPSHOT_OBJECT = "_hubi-snapshot/corpus.json.gz";

export interface CorpusSnapshot {
  version: number;
  builtAt: string;
  /** "<relative name>|<size>|<generation>" of every source object the chunks came from, sorted. */
  objects: string[];
  documentCount: number;
  chunks: Chunk[];
}

/** The source objects the service would ingest right now (metadata only, nothing is downloaded). */
export async function currentSourceSignature(): Promise<string[]> {
  const { raw, prefix } = await openGcsBucket();
  const [files] = await raw.getFiles({ prefix });
  const out: string[] = [];
  for (const f of files as { name: string; metadata?: { size?: string | number; generation?: string | number } }[]) {
    const size = Number(f.metadata?.size ?? 0);
    const { relative, action } = planObject(f.name, prefix, size);
    if (action === "download") out.push(`${relative}|${size}|${f.metadata?.generation ?? ""}`);
  }
  return out.sort();
}

function snapshotPath(prefix: string): string {
  return `${prefix ? `${prefix.replace(/\/+$/, "")}/` : ""}${SNAPSHOT_OBJECT}`;
}

export async function readSnapshot(): Promise<CorpusSnapshot | null> {
  const { raw, prefix } = await openGcsBucket();
  const file = raw.file(snapshotPath(prefix));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buffer] = await file.download();
  return JSON.parse(gunzipSync(buffer).toString("utf8")) as CorpusSnapshot;
}

export async function writeSnapshot(snapshot: CorpusSnapshot): Promise<{ object: string; bytes: number }> {
  const { raw, prefix } = await openGcsBucket();
  const body = gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"));
  const object = snapshotPath(prefix);
  await raw.file(object).save(body, { contentType: "application/gzip", resumable: false });
  return { object, bytes: body.length };
}

export function sameObjects(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
