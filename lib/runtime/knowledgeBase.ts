import { ingestContentRepository } from "../ingestion/ingest.ts";
import { resolveContentRepositoryPath } from "../ingestion/contentSource.ts";
import { buildIndex, type RetrievalIndex } from "../retrieval/index.ts";

interface KnowledgeBase {
  index: RetrievalIndex;
  documentCount: number;
  chunkCount: number;
}

let cached: Promise<KnowledgeBase> | null = null;

/**
 * Ingests Content Repository and builds the retrieval index exactly once per
 * server process (a module-level lazy singleton) rather than per-request.
 * scripts/ask.ts re-ingests on every invocation because it's a short-lived
 * CLI process; a long-lived Next.js server must not repeat that ~1-2s of
 * work on every chat request.
 *
 * Async since resolveContentRepositoryPath() may need to download the
 * Content Repository from GCS on first call (see lib/ingestion/
 * contentSource.ts) -- local development is unaffected: with
 * HUBI_CONTENT_SOURCE unset, path resolution is synchronous in effect and
 * this simply awaits a value that was already available.
 */
export async function getKnowledgeBase(): Promise<KnowledgeBase> {
  if (!cached) {
    cached = (async () => {
      const contentPath = await resolveContentRepositoryPath();
      const { documents, chunks } = ingestContentRepository(contentPath);
      return {
        index: buildIndex(chunks),
        documentCount: documents.length,
        chunkCount: chunks.length,
      };
    })();
    // A transient failure (e.g. a momentary GCS download error) must not
    // permanently wedge the process into a rejected singleton -- clear the
    // cache so the next request retries ingestion from scratch.
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}
