/**
 * Regenerates lib/governance/registrySnapshot.ts from a Content Registry export.
 *
 *   node --experimental-strip-types scripts/sync-registry.ts [export.csv] [--revision <id>] [--check]
 *
 * The export is the "Content Registry" tab downloaded as CSV (File > Download >
 * CSV), or the trimmed governance columns kept in config/governance/. With
 * --check nothing is written: the command fails if the committed snapshot no
 * longer matches the export, which is how a stale snapshot is caught in review.
 * Review the diff before committing: it is the change to what Hubi may answer from.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseRegistryCsv, validateSnapshot, type RegistrySnapshot } from "../lib/governance/registry.ts";
import { renderSnapshotModule } from "../lib/governance/snapshotModule.ts";

const SNAPSHOT_PATH = "lib/governance/registrySnapshot.ts";
const DEFAULT_EXPORT = "config/governance/registry-export.csv";
const SOURCE = "RKC | Revenue Knowledge Center - Content Registry (Content Registry tab)";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const exportPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--revision" && args[i - 1] !== "--date") ?? DEFAULT_EXPORT;
const check = args.includes("--check");

const { entries, warnings } = parseRegistryCsv(readFileSync(exportPath, "utf8"));
for (const w of warnings) console.log(`warning: ${w}`);

let previous: RegistrySnapshot | null = null;
try {
  previous = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8").split("export const REGISTRY_SNAPSHOT: RegistrySnapshot = ")[1].replace(/;\s*$/, ""));
} catch {
  previous = null;
}

const snapshot: RegistrySnapshot = {
  source: SOURCE,
  sourceRevision: flag("--revision") ?? previous?.sourceRevision ?? "unknown",
  syncedAt: flag("--date") ?? previous?.syncedAt ?? new Date().toISOString().slice(0, 10),
  entries,
};
const problems = validateSnapshot(snapshot);
if (problems.length > 0) {
  console.error(`Snapshot is invalid:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

const rendered = renderSnapshotModule(snapshot);
if (check) {
  const current = readFileSync(SNAPSHOT_PATH, "utf8");
  if (current.replace(/\r\n/g, "\n") !== rendered) {
    console.error(`${SNAPSHOT_PATH} is out of date with ${exportPath}. Run the sync and review the diff.`);
    process.exit(1);
  }
  console.log(`${SNAPSHOT_PATH} matches ${exportPath} (${entries.length} entries).`);
} else {
  writeFileSync(SNAPSHOT_PATH, rendered);
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.aiEligibility] = (counts[e.aiEligibility] ?? 0) + 1;
  console.log(`Wrote ${SNAPSHOT_PATH}: ${entries.length} entries ${JSON.stringify(counts)}`);
}
