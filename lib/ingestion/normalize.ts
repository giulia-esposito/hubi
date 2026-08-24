import type { RawBlock } from "./docx.ts";
import type { RawSlide } from "./pptx.ts";

/**
 * Fields extracted from the Revenue Knowledge Center's "1. Document Metadata"
 * table when a document follows that house template. Only fields actually
 * found in a given document are populated — nothing here is fabricated.
 */
export interface DocumentMetadata {
  contentId?: string;
  originalGuideName?: string;
  description?: string;
  sourceUrl?: string;
  learnerUrl?: string;
  taxonomyLevel1?: string;
  taxonomyLevel2?: string;
  targetAudience?: string;
  targetRegion?: string;
  creationDate?: string;
  lastUpdated?: string;
}

export interface Section {
  heading: string | null;
  headingLevel: number | null;
  text: string;
  order: number;
}

export type CitationUrlType = "learnerUrl" | "sourceUrl" | null;

export interface NormalizedDocument {
  id: string;
  title: string;
  sourceFilePath: string;
  sourceFormat: "docx" | "pptx";
  metadata: DocumentMetadata;
  citationUrl: string | null;
  citationUrlType: CitationUrlType;
  /** Whether the "Document Metadata" / "Core Knowledge Body" house template was detected. */
  usedTemplate: boolean;
  sections: Section[];
  extractionWarnings: string[];
}

const METADATA_FIELD_MAP: Record<string, keyof DocumentMetadata> = {
  "content id": "contentId",
  "original guide name": "originalGuideName",
  description: "description",
  "source url": "sourceUrl",
  "learner's url": "learnerUrl",
  "learner’s url": "learnerUrl", // curly apostrophe variant, seen in real files
  "taxonomy level 1": "taxonomyLevel1",
  "taxonomy level 2": "taxonomyLevel2",
  "target audience": "targetAudience",
  "target region": "targetRegion",
  "creation date": "creationDate",
  "last updated": "lastUpdated",
};

function headingLevelOf(style: string | null): number | null {
  if (!style) return null;
  const m = style.match(/^Heading(\d)$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Turns the raw paragraph/table blocks of a DOCX into a NormalizedDocument.
 * Prefers the Revenue Knowledge Center's own template ("1. Document Metadata"
 * table + "Core Knowledge Body" section) when present; falls back to treating
 * the whole document as content when it isn't, per Architecture.md's
 * requirement that ingestion work across mixed, not-necessarily-templated
 * source material.
 */
export function normalizeDocx(blocks: RawBlock[], sourceFilePath: string, fallbackTitle: string): NormalizedDocument {
  const warnings: string[] = [];
  let title = fallbackTitle;
  let usedTemplate = false;
  const metadata: DocumentMetadata = {};

  const firstHeading1 = blocks.find((b) => b.kind === "paragraph" && headingLevelOf(b.paragraph.style) === 1);
  if (firstHeading1 && firstHeading1.kind === "paragraph" && firstHeading1.paragraph.text.trim()) {
    title = firstHeading1.paragraph.text.trim();
  }

  let metadataStart = -1;
  let coreBodyStart = -1;
  blocks.forEach((b, idx) => {
    if (b.kind !== "paragraph") return;
    if (headingLevelOf(b.paragraph.style) !== 2) return;
    const t = b.paragraph.text.toLowerCase();
    if (metadataStart === -1 && t.includes("document metadata")) metadataStart = idx;
    if (coreBodyStart === -1 && t.includes("core knowledge body")) coreBodyStart = idx;
  });

  if (metadataStart !== -1) {
    usedTemplate = true;
    const end = coreBodyStart !== -1 ? coreBodyStart : blocks.length;
    for (let i = metadataStart + 1; i < end; i++) {
      const b = blocks[i];
      if (b.kind === "table") {
        for (const row of b.table.rows) {
          if (row.cells.length < 2) continue;
          const field = row.cells[0].trim().toLowerCase();
          const value = row.cells.slice(1).join(" ").trim();
          const key = METADATA_FIELD_MAP[field];
          if (key && value) metadata[key] = value;
        }
      }
    }
  } else {
    warnings.push('No "Document Metadata" section found — falling back to generic parsing, no structured metadata extracted.');
  }

  if (coreBodyStart === -1) {
    warnings.push('No "Core Knowledge Body" heading found — treating the whole document as content.');
  }

  const effectiveStart =
    metadataStart === -1 && coreBodyStart === -1 ? 0 : coreBodyStart !== -1 ? coreBodyStart + 1 : metadataStart + 1;

  const sections: Section[] = [];
  let current: Section | null = null;
  let order = 0;
  const pushCurrent = () => {
    if (current && current.text.trim()) sections.push(current);
  };

  for (let i = effectiveStart; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "paragraph") {
      const level = headingLevelOf(b.paragraph.style);
      if (level && level <= 4) {
        pushCurrent();
        current = { heading: b.paragraph.text.trim(), headingLevel: level, text: "", order: order++ };
      } else {
        const text = b.paragraph.text.trim();
        if (text) {
          if (!current) current = { heading: null, headingLevel: null, text: "", order: order++ };
          current.text += (current.text ? "\n" : "") + text;
        }
      }
    } else {
      const tableText = b.table.rows.map((r) => r.cells.join(" | ")).join("\n");
      if (tableText.trim()) {
        if (!current) current = { heading: null, headingLevel: null, text: "", order: order++ };
        current.text += (current.text ? "\n" : "") + `[Table]\n${tableText}`;
      }
    }
  }
  pushCurrent();

  if (sections.length === 0) {
    warnings.push("No extractable text content found in this document.");
  }

  let citationUrl: string | null = null;
  let citationUrlType: CitationUrlType = null;
  const sourceIsWorkramp = (metadata.sourceUrl ?? "").includes("workramp.com");
  if (sourceIsWorkramp && metadata.learnerUrl) {
    citationUrl = metadata.learnerUrl;
    citationUrlType = "learnerUrl";
  } else if (metadata.sourceUrl) {
    citationUrl = metadata.sourceUrl;
    citationUrlType = "sourceUrl";
  }

  return {
    id: metadata.contentId?.trim() || fallbackTitle,
    title,
    sourceFilePath,
    sourceFormat: "docx",
    metadata,
    citationUrl,
    citationUrlType,
    usedTemplate,
    sections,
    extractionWarnings: warnings,
  };
}

/**
 * Turns parsed PPTX slides into a NormalizedDocument. PPTX files have no
 * equivalent of the DOCX house template's "Document Metadata" table, so
 * usedTemplate is always false and metadata is always empty -- these files
 * carry no region/audience/citation-URL governance metadata at all, exactly
 * like the other ad hoc, non-templated documents already in the corpus.
 * Each slide becomes one Section; a slide's speaker notes (if any) are
 * appended to its text rather than dropped.
 */
export function normalizePptx(slides: RawSlide[], sourceFilePath: string, fallbackTitle: string): NormalizedDocument {
  const sections: Section[] = [];
  const warnings: string[] = [];

  slides.forEach((slide, idx) => {
    const bodyLines = [...slide.paragraphs];
    if (slide.notesParagraphs.length > 0) {
      bodyLines.push(`Speaker notes: ${slide.notesParagraphs.join(" ")}`);
    }
    const text = bodyLines.join("\n").trim();
    if (!text) return; // no extractable text on this slide -- flagged below, not silently pretended away

    const firstLine = slide.paragraphs[0] ?? null;
    const heading = firstLine && firstLine.length <= 100 ? `Slide ${slide.slideNumber}: ${firstLine}` : `Slide ${slide.slideNumber}`;

    sections.push({ heading, headingLevel: 1, text, order: idx });
  });

  const lowTextSlideCount = slides.length - sections.length;
  if (lowTextSlideCount > 0) {
    warnings.push(`${lowTextSlideCount} of ${slides.length} slides had no extractable text (likely image-only) and were skipped.`);
  }
  if (slides.length === 0) {
    warnings.push("No slides found in this presentation.");
  }

  return {
    id: fallbackTitle,
    title: fallbackTitle,
    sourceFilePath,
    sourceFormat: "pptx",
    metadata: {},
    citationUrl: null,
    citationUrlType: null,
    usedTemplate: false,
    sections,
    extractionWarnings: warnings,
  };
}
