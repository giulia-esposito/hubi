/**
 * Dry run of a content bootstrap (docs/pilot-operations.md): builds the corpus the bucket WOULD hold, locally, and
 * reports what Hubi would do with it. Nothing is uploaded, deleted or written outside the git-ignored staging folder.
 *
 *   node --experimental-strip-types scripts/dry-run-bootstrap.ts [manifest] [incoming_dir] [prod_dir]
 *
 * manifest      default config/content-bootstrap/2026-11-06-manifest.json
 * incoming_dir  the files the Product Owner downloaded from Drive (default content-incoming)
 * prod_dir      a local copy of what the bucket holds now (scripts/fetch-prod-corpus.ts; default "Content Repository (prod)")
 *
 * The candidate corpus is the current corpus, minus the objects the manifest says it replaces, plus the new files
 * named "[RKC-NNNNNN] <file>" so each resolves to its registry record. Files are hard-linked, not copied.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { applyGovernance } from "../lib/governance/governance.ts";

interface ManifestFile {
  file: string;
  contentId: string;
  replaces?: string;
}
const manifestPath = process.argv[2] ?? "config/content-bootstrap/2026-11-06-manifest.json";
const incomingDir = process.argv[3] ?? "content-incoming";
const prodDir = process.argv[4] ?? "Content Repository (prod)";
const stagingDir = "content-staging";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: ManifestFile[]; notStaged: { file: string; contentId?: string; reason: string }[] };
const replaced = new Set(manifest.files.map((f) => f.replaces).filter((x): x is string => Boolean(x)));

rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
let kept = 0;
const removed: string[] = [];
for (const name of readdirSync(prodDir)) {
  if (replaced.has(name)) {
    removed.push(name);
    continue;
  }
  linkSync(path.join(prodDir, name), path.join(stagingDir, name));
  kept++;
}
const missing: string[] = [];
let added = 0;
for (const f of manifest.files) {
  const src = path.join(incomingDir, f.file);
  if (!existsSync(src)) {
    missing.push(f.file);
    continue;
  }
  linkSync(src, path.join(stagingDir, `[${f.contentId}] ${f.file}`));
  added++;
}
console.log(`Candidate corpus: ${kept} current files kept, ${removed.length} replaced (${removed.join("; ") || "none"}), ${added} new files staged.`);
if (missing.length) console.log(`MISSING from ${incomingDir}: ${missing.join("; ")}`);
for (const n of manifest.notStaged) console.log(`not staged: ${n.contentId ?? ""} ${n.file} -- ${n.reason}`);

const started = Date.now();
const ingestion = ingestContentRepository(stagingDir);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const gov = applyGovernance(ingestion.chunks);
console.log(`\nIngestion: ${ingestion.documents.length} documents, ${ingestion.chunks.length} chunks in ${seconds}s; peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`);
console.log(`Governance: ${gov.report.chunksKept}/${gov.report.chunksIn} chunks kept; ${gov.report.registry.entries} registry entries`);

const newIds = new Set(manifest.files.map((f) => f.contentId));
const byDoc = new Map<string, { chunks: number; title: string; url: string | null; urlType: string | null; scope?: string; regions?: string; restriction?: string }>();
for (const c of gov.chunks) {
  const e = byDoc.get(c.documentId) ?? { chunks: 0, title: c.documentTitle, url: c.citationUrl, urlType: c.citationUrlType, scope: c.regionScope, regions: c.regions?.join("/"), restriction: c.governance?.restriction };
  e.chunks++;
  byDoc.set(c.documentId, e);
}
console.log("\nNew documents (kept by governance):");
for (const id of [...newIds].sort()) {
  const d = byDoc.get(id);
  if (d) console.log(`  ${id}  ${String(d.chunks).padStart(5)} chunks  region=${d.scope}${d.regions ? `(${d.regions})` : ""}  link=${d.urlType ?? "NONE"}${d.restriction ? "  CAVEAT" : ""}  ${d.title.slice(0, 60)}`);
}
console.log("\nNew documents that produced no served chunks:");
for (const id of [...newIds].sort()) {
  if (byDoc.has(id)) continue;
  const ex = gov.excluded.find((e) => e.contentId === id);
  const rep = ingestion.report.find((r) => r.file.includes(`[${id}]`));
  console.log(`  ${id}  ${ex ? `excluded: ${ex.reason}` : rep ? `${rep.status}${rep.reason ? `: ${rep.reason}` : ""}${rep.chunkCount === 0 ? " (0 chunks)" : ""}` : "not found"}`);
}
console.log("\nIngestion warnings on new files:");
for (const r of ingestion.report) {
  if (!/\[RKC-0000(7[8-9]|[89]\d|1[0-4]\d)\]/.test(r.file)) continue;
  if (r.status === "failed" || (r.warnings && r.warnings.length)) console.log(`  ${r.file}: ${r.status === "failed" ? `FAILED ${r.reason}` : r.warnings!.join(" | ")}`);
}
console.log("\nExcluded anywhere in the candidate corpus (not just new):");
for (const e of gov.excluded) console.log(`  ${e.contentId}  ${e.chunkCount} chunks  ${e.reason}`);
console.log("\nUnregistered files kept for the pilot:");
for (const u of gov.report.unregistered) console.log(`  ${u.documentId} (${u.chunkCount} chunks)`);
if (gov.report.drift.length) {
  console.log("\nRegistry vs document region drift:");
  for (const d of gov.report.drift) console.log(`  ${d.contentId}: registry "${d.registry}" vs document "${d.document}"`);
}
const sizeMb = (dir: string) => readdirSync(dir).reduce((s, n) => s + statSync(path.join(dir, n)).size, 0) / (1024 * 1024);
console.log(`\nCandidate corpus size: ${sizeMb(stagingDir).toFixed(0)} MB (the bucket holds ${sizeMb(prodDir).toFixed(0)} MB now)`);
