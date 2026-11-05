/** Exact logged label for chunks with no usable region metadata. Dependency-free so the browser bundle can import it. */
export const UNSPECIFIED_REGION_LABEL = "not specified in source metadata";

/**
 * The region text worth showing a user next to a source: a named region or "Global". An unknown region is internal
 * information (Product decision 2026-11-05) and is never shown; it stays in the logs.
 */
export function visibleRegionLabel(label: string | undefined): string | undefined {
  return label && label !== UNSPECIFIED_REGION_LABEL ? label : undefined;
}
