import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDocxRaw } from "./docx.ts";
import { parsePptxRaw } from "./pptx.ts";
import { normalizeDocx, normalizePptx, type NormalizedDocument } from "./normalize.ts";
import { chunkDocument, type Chunk } from "./chunk.ts";
import { SUPPORTED_EXTENSIONS } from "./supportedFormats.ts";

export interface IngestionReportEntry {
  file: string;
  status: "ingested" | "skipped-unsupported-format" | "failed";
  reason?: string;
  sectionCount?: number;
  chunkCount?: number;
  usedTemplate?: boolean;
  warnings?: string[];
  /** global / regional / unspecified, from the document's Target Region metadata. */
  regionScope?: string;
  /** Region metadata tokens that matched no vocabulary entry (treated as unspecified, never Global). */
  regionWarnings?: string[];
}

export interface IngestionResult {
  documents: NormalizedDocument[];
  chunks: Chunk[];
  report: IngestionReportEntry[];
}

// Supported extensions live in ./supportedFormats.ts (shared with the GCS
// content loader). Non-text assets (video, images, the redundant top-level
// .zip) are recognized and skipped here, never parsed.

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
        regionScope: docChunks[0]?.regionScope,
        regionWarnings: docChunks[0]?.unrecognizedRegionTokens?.map((t) => `unrecognized region value "${t}"`),
      });
    } catch (err) {
      report.push({ file: relative, status: "failed", reason: String((err as Error).message ?? err) });
    }
  }

  return { documents, chunks, report };
}
