import type { Chunk } from "../ingestion/chunk.ts";

/**
 * Per Prototype_Plan.md Section 6: presence of a link controls clickability,
 * not whether a citation is shown at all -- a citation is always rendered,
 * clickable or not.
 */
export function formatCitation(chunk: Chunk): string {
  const locator = chunk.heading ? `${chunk.documentTitle} -- ${chunk.heading}` : chunk.documentTitle;
  return chunk.citationUrl ? `${locator} (${chunk.citationUrl})` : `${locator} (no link available)`;
}
