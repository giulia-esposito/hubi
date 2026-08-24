import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDocxRaw } from "./docx.ts";
import { parsePptxRaw } from "./pptx.ts";
import { normalizeDocx, normalizePptx, type NormalizedDocument } from "./normalize.ts";
import { chunkDocument, type Chunk } from "./chunk.ts";

export interface IngestionReportEntry {
  file: string;
  status: "ingested" | "skipped-unsupported-format" | "failed";
  reason?: string;
  sectionCount?: number;
  chunkCount?: number;
  usedTemplate?: boolean;
  warnings?: string[];
}

export interface IngestionResult {
  documents: NormalizedDocument[];
  chunks: Chunk[];
  report: IngestionReportEntry[];
}

// DOCX and PPTX are wired up. PDF/TXT/MD parsers plug into this same
// dispatch table later — adding one means adding one entry here, not
// restructuring ingestion. Non-text assets (video, images, the redundant
// top-level .zip) are recognized and skipped, never loaded into memory.
const SUPPORTED_EXTENSIONS = new Set([".docx", ".pptx"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function ingestContentRepository(rootDir: string): IngestionResult {
  const allFiles = walk(rootDir);
  const documents: NormalizedDocument[] = [];
  const chunks: Chunk[] = [];
  const report: IngestionReportEntry[] = [];

  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase();
    const relative = path.relative(rootDir, file);

    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      report.push({ file: relative, status: "skipped-unsupported-format" });
      continue;
    }

    try {
      const buffer = readFileSync(file);
      const fallbackTitle = path.basename(file, ext);
      const doc: NormalizedDocument =
        ext === ".pptx" ? normalizePptx(parsePptxRaw(buffer), file, fallbackTitle) : normalizeDocx(parseDocxRaw(buffer), file, fallbackTitle);
      const docChunks = chunkDocument(doc);

      documents.push(doc);
      chunks.push(...docChunks);
      report.push({
        file: relative,
        status: "ingested",
        sectionCount: doc.sections.length,
        chunkCount: docChunks.length,
        usedTemplate: doc.usedTemplate,
        warnings: doc.extractionWarnings,
      });
    } catch (err) {
      report.push({ file: relative, status: "failed", reason: String((err as Error).message ?? err) });
    }
  }

  return { documents, chunks, report };
}
