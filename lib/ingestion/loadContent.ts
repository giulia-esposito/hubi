import { contentSourceMode, resolveContentRepositoryPath, streamGcsContent } from "./contentSource.ts";
import { IngestionCollector, ingestContentRepository, ingestFile, type IngestionResult } from "./ingest.ts";

/**
 * The corpus Hubi serves, from wherever it lives. Local development reads the folder directly; the deployed service
 * reads the bucket one file at a time (streamGcsContent), so memory is bounded by the largest file, not by the size
 * of the repository.
 */
export async function loadContent(): Promise<IngestionResult> {
  if (contentSourceMode() === "local") return ingestContentRepository(await resolveContentRepositoryPath());
  const collector = new IngestionCollector();
  await streamGcsContent((filePath, relative) => {
    collector.add(ingestFile(filePath, relative));
  });
  return collector.result;
}
