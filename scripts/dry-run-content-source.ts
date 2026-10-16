import path from "node:path";
import { planObject, LARGE_FILE_WARN_BYTES, MAX_FILE_BYTES } from "../lib/ingestion/contentSource.ts";

/**
 * READ-ONLY diagnostic: lists a GCS prefix (metadata only) and reports what
 * contentSource.ts would download vs skip. Never opens a read stream, never
 * writes or deletes. Uses Application Default Credentials.
 *
 * Usage: node --experimental-strip-types scripts/dry-run-content-source.ts <bucket> [prefix]
 */
const [bucketName, prefix = ""] = process.argv.slice(2);
if (!bucketName) {
  console.error("Usage: node --experimental-strip-types scripts/dry-run-content-source.ts <bucket> [prefix]");
  process.exit(1);
}

const mib = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MiB`;
const { Storage } = await import("@google-cloud/storage");
// Default: Application Default Credentials. Optional: a short-lived token from an
// existing `gcloud` login via GCS_ACCESS_TOKEN (avoids creating ADC files locally).
let storage;
if (process.env.GCS_ACCESS_TOKEN) {
  const { OAuth2Client } = await import("google-auth-library");
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: process.env.GCS_ACCESS_TOKEN });
  storage = new Storage({ authClient });
} else {
  storage = new Storage();
}
const [files] = await storage.bucket(bucketName).getFiles({ prefix });

let totalObjects = 0, totalBytes = 0, placeholders = 0;
let supported = 0, supportedBytes = 0, skipped = 0, skippedBytes = 0;
const byExt: Record<string, { count: number; bytes: number }> = {};
const supportedList: { relative: string; size: number }[] = [];
const large: { relative: string; size: number }[] = [];
const oversized: { relative: string; size: number }[] = [];

for (const file of files) {
  const size = Number(file.metadata?.size ?? 0);
  totalObjects++;
  totalBytes += size;
  const { relative, action } = planObject(file.name, prefix, size);
  if (action === "skip-placeholder") { placeholders++; continue; }
  if (action === "skip-unsupported") {
    skipped++; skippedBytes += size;
    const ext = path.extname(relative).toLowerCase() || "(none)";
    byExt[ext] ??= { count: 0, bytes: 0 };
    byExt[ext].count++; byExt[ext].bytes += size;
    continue;
  }
  if (action === "skip-oversized") { oversized.push({ relative, size }); continue; }
  supported++; supportedBytes += size;
  supportedList.push({ relative, size });
  if (size >= LARGE_FILE_WARN_BYTES) large.push({ relative, size });
}

console.log(`=== Dry run: gs://${bucketName}/${prefix} (read-only, metadata only) ===`);
console.log(`Total objects: ${totalObjects} (${placeholders} directory placeholders), ${mib(totalBytes)}`);
console.log(`Would download (supported, within limit): ${supported}, ${mib(supportedBytes)}`);
console.log(`Would skip as unsupported: ${skipped}, ${mib(skippedBytes)}`);
for (const [ext, v] of Object.entries(byExt).sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${ext.padEnd(10)} ${String(v.count).padStart(5)} files  ${mib(v.bytes)}`);
}
console.log(`Large supported files (>= ${mib(LARGE_FILE_WARN_BYTES)}): ${large.length}`);
for (const f of large) console.log(`  ${mib(f.size).padStart(11)}  ${f.relative}`);
console.log(`Supported files that would be skipped (> ${mib(MAX_FILE_BYTES)}): ${oversized.length}`);
for (const f of oversized) console.log(`  ${mib(f.size).padStart(11)}  ${f.relative}`);
console.log("\nSupported files (effective relative paths):");
for (const f of supportedList.sort((a, b) => a.relative.localeCompare(b.relative))) {
  console.log(`  ${mib(f.size).padStart(11)}  ${f.relative}`);
}
