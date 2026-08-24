import type { NormalizedDocument, Section, CitationUrlType } from "./normalize.ts";

export interface Chunk {
  id: string;
  documentId: string;
  documentTitle: string;
  heading: string | null;
  text: string;
  citationUrl: string | null;
  citationUrlType: CitationUrlType;
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
export function chunkDocument(doc: NormalizedDocument): Chunk[] {
  const chunks: Chunk[] = [];
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
      });
    });
  });
  return chunks;
}
