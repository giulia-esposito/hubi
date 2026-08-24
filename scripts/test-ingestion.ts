import { ingestContentRepository } from "../lib/ingestion/ingest.ts";

const rootDir = process.argv[2];
if (!rootDir) {
  console.error("Usage: node --experimental-strip-types scripts/test-ingestion.ts <path-to-Content-Repository>");
  process.exit(1);
}

const { documents, chunks, report } = ingestContentRepository(rootDir);

console.log("=== Ingestion report ===");
for (const entry of report) {
  if (entry.status === "skipped-unsupported-format") continue; // too noisy (media files) for the summary view
  console.log(`[${entry.status}] ${entry.file}`);
  if (entry.status === "ingested") {
    console.log(`   sections=${entry.sectionCount} chunks=${entry.chunkCount} usedTemplate=${entry.usedTemplate}`);
    if (entry.warnings?.length) console.log(`   warnings: ${entry.warnings.join(" | ")}`);
  }
  if (entry.status === "failed") console.log(`   reason: ${entry.reason}`);
}

const skipped = report.filter((r) => r.status === "skipped-unsupported-format").length;
console.log(`\n(${skipped} non-DOCX files skipped: video/image/zip — expected, not an error)`);

console.log(`\n=== Totals ===`);
console.log(`Documents ingested: ${documents.length}`);
console.log(`Total chunks: ${chunks.length}`);

console.log(`\n=== Sample: metadata extracted per document ===`);
for (const doc of documents) {
  console.log(`\n- ${doc.title} (id=${doc.id}, template=${doc.usedTemplate})`);
  console.log(`  citationUrl: ${doc.citationUrl ?? "(none — non-clickable citation)"} [${doc.citationUrlType ?? "n/a"}]`);
  console.log(`  audience=${doc.metadata.targetAudience ?? "?"} region=${doc.metadata.targetRegion ?? "?"} taxonomy=${doc.metadata.taxonomyLevel1 ?? "?"}/${doc.metadata.taxonomyLevel2 ?? "?"}`);
}

console.log(`\n=== Sample chunk (first chunk of first document) ===`);
if (chunks[0]) {
  console.log(JSON.stringify(chunks[0], null, 2));
}
