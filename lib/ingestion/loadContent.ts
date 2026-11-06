import { contentSourceMode, resolveContentRepositoryPath, streamGcsContent } from "./contentSource.ts";
import { IngestionCollector, ingestContentRepository, ingestFile } from "./ingest.ts";
import { SNAPSHOT_VERSION, currentSourceSignature, readSnapshot, sameObjects, writeSnapshot, type CorpusSnapshot } from "./corpusSnapshot.ts";
import type { Chunk } from "./chunk.ts";

/** What the runtime needs from ingestion: the chunks, and how many documents they came from. */
export interface LoadedContent {
  documentCount: number;
  chunks: Chunk[];
  /** snapshot: read from the prepared copy. ingested: every source file was read. */
  origin: "snapshot" | "ingested" | "local";
}

/** Reads every source file in the bucket, one at a time, through the ingestion pipeline. */
export async function ingestBucket(): Promise<{ documentCount: number; chunks: Chunk[] }> {
  const collector = new IngestionCollector();
  await streamGcsContent((filePath, relative) => {
    collector.add(ingestFile(filePath, relative));
  });
  return { documentCount: collector.result.documents.length, chunks: collector.result.chunks };
}

/** Ingests the bucket and stores the result as the prepared copy (scripts/build-corpus-snapshot.ts). */
export async function buildSnapshot(): Promise<{ snapshot: CorpusSnapshot; object: string; bytes: number }> {
  const objects = await currentSourceSignature();
  const { documentCount, chunks } = await ingestBucket();
  // The bucket may have changed while it was being read: a snapshot of a moving target would be stale on arrival.
  if (!sameObjects(objects, await currentSourceSignature())) throw new Error("The bucket changed while the snapshot was being built; run it again.");
  const snapshot: CorpusSnapshot = { version: SNAPSHOT_VERSION, builtAt: new Date().toISOString(), objects, documentCount, chunks };
  const written = await writeSnapshot(snapshot);
  return { snapshot, ...written };
}

/**
 * The corpus Hubi serves, from wherever it lives. Local development reads the folder directly. The deployed service
 * uses the prepared copy when the bucket still holds exactly the objects it was built from, and otherwise reads the
 * files one at a time (memory bounded by the largest file, not by the size of the repository).
 */
export async function loadContent(log: (message: string) => void = console.log): Promise<LoadedContent> {
  if (contentSourceMode() === "local") {
    const r = ingestContentRepository(await resolveContentRepositoryPath());
    return { documentCount: r.documents.length, chunks: r.chunks, origin: "local" };
  }
  if (process.env.HUBI_CORPUS_SNAPSHOT?.trim().toLowerCase() !== "off") {
    try {
      const started = Date.now();
      const [snapshot, current] = await Promise.all([readSnapshot(), currentSourceSignature()]);
      if (!snapshot) log("[loadContent] No prepared corpus in the bucket; reading the source files.");
      else if (snapshot.version !== SNAPSHOT_VERSION) log(`[loadContent] Prepared corpus is version ${snapshot.version}, expected ${SNAPSHOT_VERSION}; reading the source files.`);
      else if (!sameObjects(snapshot.objects, current)) log("[loadContent] The bucket no longer matches the prepared corpus (a document was added, replaced or removed); reading the source files.");
      else {
        log(`[loadContent] Using the prepared corpus built ${snapshot.builtAt}: ${snapshot.chunks.length} chunks from ${snapshot.documentCount} documents in ${Date.now() - started} ms.`);
        return { documentCount: snapshot.documentCount, chunks: snapshot.chunks, origin: "snapshot" };
      }
    } catch (err) {
      log(`[loadContent] Could not use the prepared corpus (${String((err as Error)?.message ?? err).slice(0, 200)}); reading the source files.`);
    }
  }
  const r = await ingestBucket();
  return { ...r, origin: "ingested" };
}
