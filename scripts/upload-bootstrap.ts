/**
 * Applies a content bootstrap manifest to the bucket the deployed service reads (docs/pilot-operations.md).
 * Prints the plan by default and changes nothing; --apply performs it.
 *
 *   node --experimental-strip-types scripts/upload-bootstrap.ts [env] [manifest] [incoming_dir]            plan only
 *   node --experimental-strip-types scripts/upload-bootstrap.ts [env] [manifest] [incoming_dir] --apply    upload and delete
 *
 * Uploads each manifest file as "[RKC-NNNNNN] <file name>" under the service's content prefix, and deletes the older
 * unregistered copies the manifest says it replaces (matched by file name, never by pattern). Objects with the same
 * name are not overwritten without --apply showing them as "replace". Application Default Credentials; no key.
 */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const positional = args.filter((a) => !a.startsWith("--"));
const envName = positional[0] ?? "pilot";
const manifestPath = positional[1] ?? "config/content-bootstrap/2026-11-06-manifest.json";
const incomingDir = positional[2] ?? "content-incoming";

const config = JSON.parse(readFileSync(`config/environments/${envName}.json`, "utf8")) as { project: string; region: string; service: string };
const describe = spawnSync("gcloud", ["run", "services", "describe", config.service, "--region", config.region, "--project", config.project, "--format=json"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });
if (describe.status !== 0) throw new Error(`gcloud describe failed: ${describe.stderr.trim()}`);
const env = JSON.parse(describe.stdout).spec.template.spec.containers[0].env as { name: string; value?: string }[];
const value = (name: string) => env.find((e) => e.name === name)?.value ?? "";
const bucketName = value("HUBI_GCS_BUCKET");
const prefix = value("HUBI_GCS_PREFIX").replace(/\/+$/, "");
if (!bucketName) throw new Error("the service has no HUBI_GCS_BUCKET");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: { file: string; contentId: string; replaces?: string }[] };
const { Storage } = await import("@google-cloud/storage");
const bucket = new Storage().bucket(bucketName);
const [existing] = await bucket.getFiles({ prefix });
const byName = new Map(existing.map((f) => [f.name, f]));
const mib = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MiB`;

console.log(`${apply ? "APPLYING" : "PLAN (nothing changes)"}: gs://${bucketName}/${prefix}  (${existing.length} objects now)\n`);
const uploads: { src: string; dest: string; size: number; replaces: boolean }[] = [];
const problems: string[] = [];
for (const f of manifest.files) {
  const src = path.join(incomingDir, f.file);
  if (!existsSync(src)) {
    problems.push(`missing local file: ${f.file}`);
    continue;
  }
  const dest = `${prefix}/[${f.contentId}] ${f.file.replace(/^\[RKC-\d{6}\]\s*/, "")}`;
  uploads.push({ src, dest, size: statSync(src).size, replaces: byName.has(dest) });
}
const deletes: string[] = [];
for (const f of manifest.files) {
  if (!f.replaces) continue;
  const matches = existing.filter((o) => path.posix.basename(o.name) === f.replaces);
  if (matches.length !== 1) problems.push(`expected exactly one existing object named "${f.replaces}", found ${matches.length}`);
  else deletes.push(matches[0].name);
}
for (const u of uploads) console.log(`  ${u.replaces ? "replace" : "upload "}  ${mib(u.size).padStart(10)}  ${u.dest}`);
for (const d of deletes) console.log(`  delete   ${"".padStart(10)}  ${d}`);
console.log(`\n${uploads.length} uploads (${mib(uploads.reduce((s, u) => s + u.size, 0))}), ${deletes.length} deletions.`);
if (problems.length) {
  console.log(`\nPROBLEMS:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
if (!apply) {
  console.log("\nRe-run with --apply to perform it.");
  process.exit(0);
}
for (const u of uploads) {
  await pipeline(createReadStream(u.src), bucket.file(u.dest).createWriteStream({ resumable: true }));
  console.log(`uploaded ${u.dest}`);
}
for (const d of deletes) {
  await bucket.file(d).delete();
  console.log(`deleted  ${d}`);
}
console.log("\nDone. Running instances read the bucket at start: deploy a new revision (or restart) to pick it up.");
