import { readZipEntries } from "./zip.ts";

export interface RawSlide {
  slideNumber: number;
  /** One entry per <a:p> paragraph; runs within a paragraph are already joined. */
  paragraphs: string[];
  notesParagraphs: string[];
}

/**
 * Parses a .pptx file into an ordered list of slides (real presentation
 * order, not filename order) with their text and speaker notes. Zero
 * dependency, same rationale as docx.ts: a PPTX is a ZIP of XML, and
 * readZipEntries already handles that generically for both formats.
 */
export function parsePptxRaw(buffer: Buffer): RawSlide[] {
  const entries = readZipEntries(buffer);

  const presentationXml = entries.get("ppt/presentation.xml");
  const presRelsXml = entries.get("ppt/_rels/presentation.xml.rels");
  if (!presentationXml || !presRelsXml) {
    throw new Error('"ppt/presentation.xml" or its relationships not found — not a valid PPTX file');
  }

  // Real slide order comes from presentation.xml's <p:sldId r:id="..."> list,
  // resolved through presentation.xml.rels -- slideN.xml filenames are not
  // guaranteed to match display order.
  const relMap = parseRelationships(presRelsXml.toString("utf8"));
  const sldIdRegex = /<p:sldId\b[^>]*r:id="(rId\d+)"/g;
  const presStr = presentationXml.toString("utf8");
  const orderedSlideTargets: string[] = [];
  let sldMatch: RegExpExecArray | null;
  while ((sldMatch = sldIdRegex.exec(presStr))) {
    const target = relMap.get(sldMatch[1]);
    if (target) orderedSlideTargets.push(target.replace(/^\.?\/?/, ""));
  }

  const slides: RawSlide[] = [];
  orderedSlideTargets.forEach((relTarget, idx) => {
    const slideXml = entries.get(`ppt/${relTarget}`);
    if (!slideXml) return; // a genuinely missing slide part shouldn't fail the whole file

    const paragraphs = extractParagraphTexts(slideXml.toString("utf8"));

    // Notes are matched by parallel filename numbering (slideN.xml <->
    // notesSlideN.xml), not by resolving the slide's own .rels file -- a
    // deliberate simplification that holds for real PPTX files in practice.
    const numMatch = relTarget.match(/slide(\d+)\.xml$/);
    let notesParagraphs: string[] = [];
    if (numMatch) {
      const notesXml = entries.get(`ppt/notesSlides/notesSlide${numMatch[1]}.xml`);
      if (notesXml) notesParagraphs = extractParagraphTexts(notesXml.toString("utf8"));
    }

    slides.push({ slideNumber: idx + 1, paragraphs, notesParagraphs });
  });

  return slides;
}

function parseRelationships(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const relRegex = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = relRegex.exec(relsXml))) {
    map.set(m[1], m[2]);
  }
  return map;
}

// Extracts text per <a:p> paragraph, joining runs within a paragraph with no
// separator (correct -- they're fragments of one sentence) but keeping
// paragraphs themselves as separate array entries, so the caller can join
// them with newlines. This is deliberately paragraph-aware, unlike
// docx.ts's extractRunText -- see Prototype_Plan.md / validation-findings.md
// for the table-cell text run-together bug that pattern caused in DOCX.
function extractParagraphTexts(xml: string): string[] {
  const paragraphs: string[] = [];
  const pRegex = /<a:p>[\s\S]*?<\/a:p>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pRegex.exec(xml))) {
    const runs = [...pMatch[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const text = runs.join("").trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
