/**
 * Ingest memory and time probe: parses a content folder and builds the governed index, then prints the peak
 * resident memory. Used to size the Cloud Run memory limit against the real corpus (audit item P1-4).
 *
 *   node --experimental-strip-types scripts/measure-ingest.ts "Content Repository (prod)"
 *
 * Read-only. Note the deployed process also holds the Next.js server and, on startup, the GCS download buffers,
 * so compare the peak with the limit with generous headroom, not to the limit itself.
 */
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";

const dir = process.argv[2];
if (!dir) {
  console.error('usage: measure-ingest.ts "<content folder>"');
  process.exit(2);
}
const mb = (n: number) => Math.round(n / 1048576);
const base = process.memoryUsage().rss;
let peak = base;
const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
const t0 = Date.now();
const { chunks, documents } = ingestContentRepository(dir);
const parseMs = Date.now() - t0;
buildGovernedIndex(chunks);
peak = Math.max(peak, process.memoryUsage().rss);
clearInterval(timer);
console.log(JSON.stringify({ docs: documents.length, chunks: chunks.length, parseMs, totalMs: Date.now() - t0, rssBaseMB: mb(base), rssPeakMB: mb(peak), heapAfterMB: mb(process.memoryUsage().heapUsed) }));
