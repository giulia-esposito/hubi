import { readZipEntries } from "./zip.ts";

export interface Hyperlink {
  text: string;
  url: string;
}

export interface RawParagraph {
  /** Word style id, e.g. "Heading1", "Heading2", or null for normal body text. */
  style: string | null;
  text: string;
  hyperlinks: Hyperlink[];
}

export interface RawTableRow {
  cells: string[];
}

export interface RawTable {
  rows: RawTableRow[];
}

export type RawBlock = { kind: "paragraph"; paragraph: RawParagraph } | { kind: "table"; table: RawTable };

/**
 * Parses a .docx file's word/document.xml (+ hyperlink relationships) into an
 * ordered list of paragraph/table blocks. Deliberately implemented with regex
 * over the raw XML rather than a full XML DOM — DOCX's WordprocessingML is
 * verbose but structurally simple for the elements we need (paragraphs, run
 * text, paragraph styles, tables, hyperlinks), and avoids pulling in an XML
 * parsing dependency for this narrow extraction task.
 */
export function parseDocxRaw(buffer: Buffer): RawBlock[] {
  const entries = readZipEntries(buffer);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) {
    throw new Error('"word/document.xml" not found inside the archive — not a valid DOCX file');
  }
  const relsXml = entries.get("word/_rels/document.xml.rels");
  const relMap = relsXml ? parseRelationships(relsXml.toString("utf8")) : new Map<string, string>();

  const xml = documentXml.toString("utf8");
  const bodyMatch = xml.match(/<w:body>([\s\S]*)<\/w:body>/);
  const body = bodyMatch ? bodyMatch[1] : xml;

  const blocks: RawBlock[] = [];
  const blockRegex = /<w:p\b[\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(body))) {
    const raw = match[0];
    if (raw.startsWith("<w:tbl>")) {
      blocks.push({ kind: "table", table: parseTable(raw) });
    } else {
      blocks.push({ kind: "paragraph", paragraph: parseParagraph(raw, relMap) });
    }
  }
  return blocks;
}

function parseRelationships(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const relRegex = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = relRegex.exec(relsXml))) {
    map.set(m[1], decodeXmlEntities(m[2]));
  }
  return map;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractRunText(xmlFragment: string): string {
  const texts = [...xmlFragment.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => decodeXmlEntities(m[1]));
  return texts.join("");
}

function parseParagraph(pXml: string, relMap: Map<string, string>): RawParagraph {
  const styleMatch = pXml.match(/<w:pStyle w:val="([^"]+)"/);
  const style = styleMatch ? styleMatch[1] : null;

  const hyperlinks: Hyperlink[] = [];
  const hyperlinkRegex = /<w:hyperlink\b[^>]*r:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/g;
  let hm: RegExpExecArray | null;
  while ((hm = hyperlinkRegex.exec(pXml))) {
    const url = relMap.get(hm[1]);
    if (url) hyperlinks.push({ text: extractRunText(hm[2]), url });
  }

  return { style, text: extractRunText(pXml), hyperlinks };
}

function parseTable(tblXml: string): RawTable {
  const rows: RawTableRow[] = [];
  const rowRegex = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRegex.exec(tblXml))) {
    const rowXml = rm[0];
    const cellRegex = /<w:tc\b[\s\S]*?<\/w:tc>/g;
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = cellRegex.exec(rowXml))) {
      cells.push(extractRunText(cm[0]).trim());
    }
    rows.push({ cells });
  }
  return { rows };
}
