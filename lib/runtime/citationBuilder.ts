import type { Chunk } from "../ingestion/chunk.ts";
import { regionLabel } from "../applicability/evaluate.ts";

/**
 * Per Prototype_Plan.md Section 6: presence of a link controls clickability,
 * not whether a citation is shown at all -- a citation is always rendered,
 * clickable or not.
 */
export function formatCitation(chunk: Chunk): string {
  const locator = chunk.heading ? `${chunk.documentTitle} -- ${chunk.heading}` : chunk.documentTitle;
  return chunk.citationUrl ? `${locator} (${chunk.citationUrl})` : `${locator} (no link available)`;
}

/**
 * The applicability label shown next to a citation (terminal, web UI) so a
 * human reviewing sources can see whether a source is Global, region-specific
 * or of unknown scope. Kept separate from formatCitation so the validated
 * citation string is unchanged.
 */
export function formatApplicabilityLabel(chunk: Chunk): string {
  return `region: ${regionLabel(chunk)}`;
}
