/**
 * Repeatable retrieval benchmark: no model call, deterministic, runs in seconds
 * on the real corpus (benchmarks/retrieval/gold.json, scored by
 * lib/retrieval/benchmark.ts).
 *
 *   node --experimental-strip-types scripts/eval-retrieval.ts [--misses] [--json out.json] [--write-baseline] [--check]
 *
 * It measures two layers. "raw" is BM25 over the governed index, the pass-1 depth
 * the runtime uses. "served" is what reaches the model after the Applicability
 * Layer and the conditional fact pass (retrieveApplicable), with the question
 * alone as context, so a region-specific document legitimately drops out when
 * the question names no region; read it next to the raw numbers, not instead.
 *
 * --check compares with benchmarks/retrieval/baseline.json and exits non-zero
 * when Recall@5, Recall@15 or MRR fall: the guard to run before any change to
 * tokenization, chunking, scoring or the retrieval depth.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import { search } from "../lib/retrieval/index.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { byCategory, compareToBaseline, CUTOFFS, scoreCase, summarize, validateCases, type BenchmarkCase, type CaseResult, type Metrics } from "../lib/retrieval/benchmark.ts";

const GOLD = "benchmarks/retrieval/gold.json";
const BASELINE = "benchmarks/retrieval/baseline.json";
const RAW_DEPTH = 15;

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;

const cases: BenchmarkCase[] = JSON.parse(readFileSync(GOLD, "utf8"));
const problems = validateCases(cases);
if (problems.length > 0) {
  console.error(`Gold set is invalid:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

const { chunks } = ingestContentRepository(process.env.HUBI_CONTENT_REPOSITORY_PATH?.trim() || "Content Repository");
const { index } = buildGovernedIndex(chunks);

const raw: CaseResult[] = [];
const served: CaseResult[] = [];
const modes: Record<string, string> = {};
for (const c of cases) {
  raw.push(scoreCase(c, search(index, c.question, RAW_DEPTH)));
  const { decision } = retrieveApplicable(index, [c.regionContext, c.question].filter(Boolean).join(" "), [c.regionContext, c.question].filter((m): m is string => Boolean(m)), {});
  modes[c.id] = decision.mode;
  served.push(scoreCase(c, decision.eligible));
}

const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4);
function row(label: string, m: Metrics): string {
  return `  ${label.padEnd(16)} n=${String(m.cases).padStart(2)}  ` + CUTOFFS.map((k) => `R@${k} ${pct(m.recallAt[k])}`).join("  ") + `  MRR ${m.mrr.toFixed(3)}  coverage ${pct(m.coverage)}`;
}

function report(title: string, results: CaseResult[]): Metrics {
  const overall = summarize(results);
  console.log(`\n${title}`);
  console.log(row("ALL", overall));
  for (const [category, m] of Object.entries(byCategory(results))) console.log(row(category, m));
  return overall;
}

const rawMetrics = report(`RAW  BM25 top ${RAW_DEPTH} over ${index.n} governed chunks`, raw);
const servedMetrics = report("SERVED  after applicability and the fact pass (what the model sees)", served);

if (args.includes("--misses")) {
  console.log("\nRaw misses (no relevant passage in the top " + RAW_DEPTH + "):");
  for (const r of raw.filter((x) => x.rank === null)) console.log(`  ${r.id.padEnd(26)} [${r.category}] top docs: ${r.topDocs.join(" | ") || "none"}`);
  console.log("\nRaw hits ranked below 5:");
  for (const r of raw.filter((x) => x.rank !== null && x.rank > 5)) console.log(`  ${r.id.padEnd(26)} [${r.category}] first relevant at rank ${r.rank}`);
  console.log("\nServed misses where applicability changed the outcome:");
  for (const r of served.filter((x, i) => x.rank === null && raw[i].rank !== null)) console.log(`  ${r.id.padEnd(26)} applicability mode: ${modes[r.id]}`);
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ raw: rawMetrics, served: servedMetrics, cases: raw }, null, 2));

if (args.includes("--write-baseline")) {
  writeFileSync(BASELINE, JSON.stringify({ corpusChunks: index.n, gold: cases.length, raw: rawMetrics, served: servedMetrics }, null, 2) + "\n");
  console.log(`\nWrote ${BASELINE}`);
}

if (args.includes("--check")) {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { raw: Metrics; served: Metrics };
  const results = [
    ["raw", compareToBaseline(rawMetrics, baseline.raw)],
    ["served", compareToBaseline(servedMetrics, baseline.served)],
  ] as const;
  let failed = false;
  for (const [name, check] of results) {
    if (!check.ok) {
      failed = true;
      for (const f of check.failures) console.error(`REGRESSION (${name}): ${f}`);
    }
  }
  if (failed) process.exit(1);
  console.log("\nNo regression against the baseline.");
}
