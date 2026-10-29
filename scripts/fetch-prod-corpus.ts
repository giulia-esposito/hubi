/**
 * Copies the documents the deployed pilot actually serves into one local folder, so evaluations run on the
 * same corpus as production (the pilot reads a Cloud Storage bucket, not the local "Content Repository").
 *
 *   node --experimental-strip-types scripts/fetch-prod-corpus.ts [env] [out_dir]
 *
 * env      the deploy environment in config/environments/<env>.json (default: pilot)
 * out_dir  destination (default: "Content Repository (prod)", gitignored: the content is confidential)
 *
 * It selects objects with the same rule the running service uses (planObject in
 * lib/ingestion/contentSource.ts: supported formats only, oversized files skipped), reads the bucket and
 * prefix from the running service, and flattens the object names: the export is a nested Google Drive
 * download whose paths exceed the Windows 260-character limit. Ingestion reads the metadata inside each
 * document and uses the file name only for files that have none, so flattening keeps what matters.
 * Uses Application Default Credentials (gcloud auth application-default login); no key is involved.
 *
 *   HUBI_CONTENT_REPOSITORY_PATH="Content Repository (prod)" npm run eval:retrieval -- --expand
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { planObject } from "../lib/ingestion/contentSource.ts";

const envName = process.argv[2] ?? "pilot";
const outDir = process.argv[3] ?? "Content Repository (prod)";
const config = JSON.parse(readFileSync(`config/environments/${envName}.json`, "utf8")) as { project: string; region: string; service: string };

// The bucket and prefix come from the running service, so this follows the deployed configuration.
const describe = spawnSync("gcloud", ["run", "services", "describe", config.service, "--region", config.region, "--project", config.project, "--format=json"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });
if (describe.status !== 0) throw new Error(`gcloud describe failed: ${describe.stderr.trim()}`);
const env = JSON.parse(describe.stdout).spec.template.spec.containers[0].env as { name: string; value?: string }[];
const value = (name: string) => env.find((e) => e.name === name)?.value ?? "";
const bucketName = value("HUBI_GCS_BUCKET");
const prefix = value("HUBI_GCS_PREFIX");
if (!bucketName) throw new Error("the service has no HUBI_GCS_BUCKET");
console.log(`Bucket: gs://${bucketName}/${prefix}`);

const { Storage } = await import("@google-cloud/storage");
const bucket = new Storage().bucket(bucketName);
const [files] = await bucket.getFiles({ prefix });

mkdirSync(outDir, { recursive: true });
let copied = 0;
let skipped = 0;
let bytes = 0;
const used = new Set<string>();
for (const file of files) {
  const plan = planObject(file.name, prefix, Number(file.metadata?.size ?? 0));
  if (plan.action !== "download") {
    skipped++;
    continue;
  }
  let base = path.basename(plan.relative);
  if (used.has(base)) base = `${copied}_${base}`;
  used.add(base);
  const dest = path.join(outDir, base);
  if (!existsSync(dest)) await pipeline(file.createReadStream(), createWriteStream(dest));
  copied++;
  bytes += Number(file.metadata?.size ?? 0);
}
console.log(`Copied ${copied} documents (${(bytes / 1048576).toFixed(0)} MB) into: ${outDir}; skipped ${skipped} other objects.`);
