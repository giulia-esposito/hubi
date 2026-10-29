import type { NormalizedDocument, Section, CitationUrlType } from "./normalize.ts";
import { getRegionVocabulary, parseAudience, parseRegionMetadata, type RegionScope, type RegionVocabulary } from "../applicability/regions.ts";

export interface Chunk {
  id: string;
  documentId: string;
  documentTitle: string;
  heading: string | null;
  text: string;
  citationUrl: string | null;
  citationUrlType: CitationUrlType;
  /**
   * Applicability metadata propagated from the document (Finding #002). All
   * optional so existing Chunk literals stay valid; a missing value means
   * "unspecified", never "Global".
   */
  /** Canonical regions the content applies to ("Global" when the metadata says so). */
  regions?: string[];
  /** global only when the metadata literally says Global; unspecified means scope unknown. */
  regionScope?: RegionScope;
  /** The document's raw "Target Region" value, for traceability. */
  regionRaw?: string;
  /** Raw metadata tokens no vocabulary entry recognized. Reported, never guessed. */
  unrecognizedRegionTokens?: string[];
  /** Label-only in this slice; not used for gating. */
  audience?: string[];
  /** The document's own "Last Updated" (else "Creation Date") metadata value, raw: the primary freshness source. */
  documentDate?: string;
  /**
   * Set by the governance gate (lib/governance/governance.ts), never by ingestion: how the Content
   * Registry classified this document. Absent on chunks that have not passed through the gate.
   */
  governance?: ChunkGovernance;
}

export interface ChunkGovernance {
  /** registered: listed in the Content Registry. unregistered: no registry identifier, so no governance record exists. */
  status: "registered" | "unregistered";
  aiEligibility?: string;
  /** The registry's caveat for an Eligible with Restrictions document; shown with the source. */
  restriction?: string;
  risks?: string[];
  /** Source facts from the registry, used to label sources and to choose between them (docs/source-selection-design.md). */
  contentType?: string;
  collection?: string;
  accessLevel?: string;
  sourceModified?: string;
}

// Keeps a chunk small enough to be a tight, specific citation while staying
// large enough to carry real context. No embeddings involved, so this is
// just a practical readability/citation-granularity limit, not a model
// context-window constraint.
const MAX_WORDS_PER_CHUNK = 220;

function splitLongText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_WORDS_PER_CHUNK) return [text];
  const parts: string[] = [];
  for (let i = 0; i < words.length; i += MAX_WORDS_PER_CHUNK) {
    parts.push(words.slice(i, i + MAX_WORDS_PER_CHUNK).join(" "));
  }
  return parts;
}

/**
 * Splits a NormalizedDocument's sections into retrieval-sized chunks.
 * Every chunk keeps its parent section's heading as its citation locator —
 * splitting for retrieval granularity never degrades citation granularity.
 */
export function chunkDocument(doc: NormalizedDocument, vocabulary: RegionVocabulary = getRegionVocabulary()): Chunk[] {
  const chunks: Chunk[] = [];
  const region = parseRegionMetadata(vocabulary, doc.metadata.targetRegion);
  const audience = parseAudience(doc.metadata.targetAudience);
  doc.sections.forEach((section: Section, idx: number) => {
    const parts = splitLongText(section.text);
    parts.forEach((part, partIdx) => {
      chunks.push({
        id: `${doc.id}::s${idx}${parts.length > 1 ? `.${partIdx}` : ""}`,
        documentId: doc.id,
        documentTitle: doc.title,
        heading: section.heading,
        text: part,
        citationUrl: doc.citationUrl,
        citationUrlType: doc.citationUrlType,
        regions: region.regions,
        regionScope: region.scope,
        regionRaw: doc.metadata.targetRegion,
        unrecognizedRegionTokens: region.unrecognized.length ? region.unrecognized : undefined,
        audience: audience.length ? audience : undefined,
        documentDate: doc.metadata.lastUpdated ?? doc.metadata.creationDate,
      });
    });
  });
  return chunks;
}
