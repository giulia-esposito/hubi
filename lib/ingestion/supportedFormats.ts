import path from "node:path";

/**
 * Single source of truth for which file types the ingestion pipeline can
 * parse. Shared by the content loader (lib/ingestion/contentSource.ts, which
 * must never download anything else) and the ingestion dispatch
 * (lib/ingestion/ingest.ts). DOCX and PPTX are wired up; PDF/TXT/MD parsers
 * plug in by adding an extension here together with a parser in ingest.ts.
 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([".docx", ".pptx"]);

export function isSupportedFile(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase());
}
