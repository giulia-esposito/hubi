/**
 * Builds the prepared copy of the corpus (lib/ingestion/corpusSnapshot.ts) from the bucket the deployed service reads,
 * and stores it next to the documents. Run it after every content change; until then the service reads the files.
 *
 *   node --experimental-strip-types scripts/build-corpus-snapshot.ts [env]
 *
 * Reads every source file (minutes, mostly download time), so run it from a machine with a good connection.
 * Application Default Credentials; no key.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildSnapshot } from "../lib/ingestion/loadContent.ts";

const envName = process.argv[2] ?? "pilot";
const config = JSON.parse(readFileSync(`config/environments/${envName}.json`, "utf8")) as { project: string; region: string; service: string };
const describe = spawnSync("gcloud", ["run", "services", "describe", config.service, "--region", config.region, "--project", config.project, "--format=json"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });
if (describe.status !== 0) throw new Error(`gcloud describe failed: ${describe.stderr.trim()}`);
const env = JSON.parse(describe.stdout).spec.template.spec.containers[0].env as { name: string; value?: string }[];
process.env.HUBI_CONTENT_SOURCE = "gcs";
process.env.HUBI_GCS_BUCKET = env.find((e) => e.name === "HUBI_GCS_BUCKET")?.value ?? "";
process.env.HUBI_GCS_PREFIX = env.find((e) => e.name === "HUBI_GCS_PREFIX")?.value ?? "";

const started = Date.now();
const { snapshot, object, bytes } = await buildSnapshot();
console.log(`\nWrote gs://${process.env.HUBI_GCS_BUCKET}/${object}: ${snapshot.chunks.length} chunks from ${snapshot.documentCount} documents, ${snapshot.objects.length} source objects, ${(bytes / 1024 / 1024).toFixed(1)} MiB, in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
