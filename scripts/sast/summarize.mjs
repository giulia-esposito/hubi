// Step 5 of the wh-infosec-sast-review skill, as a script: raptor-custom goes to triage whole;
// raptor-registry is filtered to important findings (WARNING/ERROR, category security,
// confidence and impact MEDIUM or HIGH). Everything filtered out is counted, never dropped silently.
import { readFileSync, writeFileSync } from "node:fs";

const [customPath, registryPath, outPath] = process.argv.slice(2);
const load = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return { results: [], errors: [{ message: `unreadable: ${p}` }] };
  }
};
const custom = load(customPath);
const registry = load(registryPath);

const slim = (r, source) => ({
  source,
  rule: r.check_id,
  severity: r.extra?.severity,
  file: r.path,
  line: r.start?.line,
  message: String(r.extra?.message ?? "").slice(0, 300),
  code: String(r.extra?.lines ?? "").slice(0, 200),
  confidence: r.extra?.metadata?.confidence,
  impact: r.extra?.metadata?.impact,
  category: r.extra?.metadata?.category,
});

const important = (r) => {
  const m = r.extra?.metadata ?? {};
  return ["WARNING", "ERROR"].includes(r.extra?.severity) && m.category === "security" && ["MEDIUM", "HIGH"].includes(m.confidence) && ["MEDIUM", "HIGH"].includes(m.impact);
};

const keptRegistry = registry.results.filter(important);
const excluded = registry.results.filter((r) => !important(r));
const excludedByRule = {};
for (const r of excluded) excludedByRule[r.check_id] = (excludedByRule[r.check_id] ?? 0) + 1;

// Same spot flagged by both sources: keep one entry with both tags.
const merged = new Map();
for (const r of [...custom.results.map((x) => slim(x, "raptor-custom")), ...keptRegistry.map((x) => slim(x, "raptor-registry"))]) {
  const key = `${r.file}:${r.line}`;
  const prior = merged.get(key);
  if (prior) prior.source = `${prior.source}+${r.source}`;
  else merged.set(key, r);
}

const summary = {
  scannedErrors: { custom: custom.errors?.length ?? 0, registry: registry.errors?.length ?? 0 },
  totals: { customFindings: custom.results.length, registryFindings: registry.results.length, registryImportant: keptRegistry.length, registryExcluded: excluded.length, toTriage: merged.size },
  findings: [...merged.values()],
  notTriaged: excludedByRule,
};
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`custom: ${custom.results.length} findings (all to triage)`);
console.log(`registry: ${registry.results.length} findings, ${keptRegistry.length} important, ${excluded.length} excluded`);
console.log(`to triage after merge: ${merged.size}`);
console.log(`scan errors: custom ${summary.scannedErrors.custom}, registry ${summary.scannedErrors.registry}`);
