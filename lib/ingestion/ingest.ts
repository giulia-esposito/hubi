import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDocxRaw } from "./docx.ts";
import { parsePptxRaw } from "./pptx.ts";
import { normalizeDocx, normalizeMarkdown, normalizePptx, type NormalizedDocument } from "./normalize.ts";
import { chunkDocument, type Chunk } from "./chunk.ts";
import { resolveIdentity } from "./identity.ts";
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

export interface FileIngestion {
  document?: NormalizedDocument;
  chunks: Chunk[];
  entry: IngestionReportEntry;
}

/**
 * One file through the pipeline: parse, normalize, resolve its registry identity, chunk. Never throws: a failure
 * is a report entry. Shared by the directory walk and the streaming loader (lib/ingestion/loadContent.ts), so a
 * file is read the same way wherever it comes from.
 */
export function ingestFile(file: string, relative: string): FileIngestion {
  const ext = path.extname(file).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) return { chunks: [], entry: { file: relative, status: "skipped-unsupported-format" } };

  try {
    const buffer = readFileSync(file);
    const fallbackTitle = path.basename(file, ext);
    const doc: NormalizedDocument =
      ext === ".pptx"
        ? normalizePptx(parsePptxRaw(buffer), file, fallbackTitle)
        : ext === ".md"
          ? normalizeMarkdown(buffer.toString("utf8"), file, fallbackTitle)
          : normalizeDocx(parseDocxRaw(buffer), file, fallbackTitle);
    // A Word document without the house template has no title of its own: its first Heading 1 is a section heading
    // ("Purpose of this playbook" opens eleven different playbooks), so the file name, which is the document's name, wins.
    if (ext === ".docx" && !doc.usedTemplate) doc.title = fallbackTitle;
    // The registry record this file is: the Content ID row, the "[RKC-...]" in its path, or (neither) its title.
    const identity = resolveIdentity(doc.id, fallbackTitle, relative, ext === ".docx" && Boolean(doc.metadata.contentId?.trim()));
    doc.id = identity.id;
    const docChunks = chunkDocument(doc);
    if (identity.conflict) for (const c of docChunks) c.identityConflict = identity.conflict;

    return {
      document: doc,
      chunks: docChunks,
      entry: {
        file: relative,
        status: "ingested",
        sectionCount: doc.sections.length,
        chunkCount: docChunks.length,
        usedTemplate: doc.usedTemplate,
        warnings: doc.extractionWarnings,
        regionScope: docChunks[0]?.regionScope,
        regionWarnings: docChunks[0]?.unrecognizedRegionTokens?.map((t) => `unrecognized region value "${t}"`),
      },
    };
  } catch (err) {
    return { chunks: [], entry: { file: relative, status: "failed", reason: String((err as Error).message ?? err) } };
  }
}

/** Collects per-file results into one IngestionResult. */
export class IngestionCollector {
  readonly result: IngestionResult = { documents: [], chunks: [], report: [] };
  add(r: FileIngestion): void {
    if (r.document) this.result.documents.push(r.document);
    this.result.chunks.push(...r.chunks);
    this.result.report.push(r.entry);
  }
}

export function ingestContentRepository(rootDir: string): IngestionResult {
  const collector = new IngestionCollector();
  for (const file of walk(rootDir)) collector.add(ingestFile(file, path.relative(rootDir, file)));
  return collector.result;
}
