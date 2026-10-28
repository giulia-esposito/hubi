/**
 * Repeatable retrieval benchmark: deterministic, runs in seconds on the real
 * corpus (benchmarks/retrieval/gold.json, scored by lib/retrieval/benchmark.ts).
 *
 *   node --experimental-strip-types scripts/eval-retrieval.ts [--misses] [--json out.json]
 *       [--expand | --expand-live] [--write-baseline] [--check]
 *
 * It measures two layers. "raw" is BM25 over the governed index, the pass-1 depth
 * the runtime uses. "served" is what reaches the model after the Applicability
 * Layer and the conditional fact pass (retrieveApplicable), with the question
 * alone as context (plus a region statement where the document is region-
 * specific), so legitimate withholding is not counted as a miss.
 *
 * --expand adds the cross-language layers (lib/retrieval/queryExpansion.ts), using
 * the expansions recorded in benchmarks/retrieval/expansions.json, so it stays
 * deterministic and offline. --expand-live makes the real model calls
 * (HUBI_REASONING_PROVIDER=gemini GOOGLE_CLOUD_PROJECT=<project>) and re-records
 * that file.
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
import { expandQuery, searchWithExpansion, type ExpansionInfo } from "../lib/retrieval/queryExpansion.ts";
import { getReasoningEngine } from "../lib/runtime/reasoningEngine.ts";
import { byCategory, compareToBaseline, CUTOFFS, scoreCase, summarize, validateCases, type BenchmarkCase, type CaseResult, type Metrics } from "../lib/retrieval/benchmark.ts";

const GOLD = "benchmarks/retrieval/gold.json";
const BASELINE = "benchmarks/retrieval/baseline.json";
const EXPANSIONS = "benchmarks/retrieval/expansions.json";
const RAW_DEPTH = 15;

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const expandMode = args.includes("--expand-live") ? "live" : args.includes("--expand") ? "replay" : null;

const cases: BenchmarkCase[] = JSON.parse(readFileSync(GOLD, "utf8"));
const problems = validateCases(cases);
if (problems.length > 0) {
  console.error(`Gold set is invalid:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

const { chunks } = ingestContentRepository(process.env.HUBI_CONTENT_REPOSITORY_PATH?.trim() || "Content Repository");
const { index } = buildGovernedIndex(chunks);

/** What retrieval is given for one case: the retrieval query, and the user messages the region is read from. */
const messagesOf = (c: BenchmarkCase) => [c.regionContext, c.question].filter((m): m is string => Boolean(m));

const raw: CaseResult[] = [];
const served: CaseResult[] = [];
const modes: Record<string, string> = {};
for (const c of cases) {
  raw.push(scoreCase(c, search(index, c.question, RAW_DEPTH)));
  const messages = messagesOf(c);
  const { decision } = retrieveApplicable(index, messages.join(" "), messages, {});
  modes[c.id] = decision.mode;
  served.push(scoreCase(c, decision.eligible));
}

type Recorded = Pick<ExpansionInfo, "triggered" | "reason" | "language" | "terms" | "ms">;
const NOT_EXPANDED: Recorded = { triggered: false, reason: "sufficient", language: "unknown", terms: "", ms: 0 };
const expansions: Record<string, Recorded> = {};
const rawExpanded: CaseResult[] = [];
const servedExpanded: CaseResult[] = [];
if (expandMode) {
  const recorded: Record<string, Recorded> = expandMode === "replay" ? JSON.parse(readFileSync(EXPANSIONS, "utf8")) : {};
  const engine = expandMode === "live" ? getReasoningEngine() : undefined;
  for (const c of cases) {
    const messages = messagesOf(c);
    const info: Recorded = engine ? await expandQuery({ engine, index, query: messages.join(" "), latestMessage: c.question }) : (recorded[c.id] ?? NOT_EXPANDED);
    expansions[c.id] = { triggered: info.triggered, reason: info.reason, language: info.language, terms: info.terms, ms: info.ms };

    rawExpanded.push(scoreCase(c, searchWithExpansion(index, c.question, info, RAW_DEPTH)));

    const { decision } = retrieveApplicable(index, messages.join(" "), messages, { expansion: info.terms ? info : undefined });
    servedExpanded.push(scoreCase(c, decision.eligible));
  }
  if (expandMode === "live") writeFileSync(EXPANSIONS, JSON.stringify(expansions, null, 2) + "\n");
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
let rawExpandedMetrics: Metrics | undefined;
let servedExpandedMetrics: Metrics | undefined;
if (expandMode) {
  const triggered = Object.values(expansions).filter((e) => e.triggered);
  const meanMs = triggered.length ? Math.round(triggered.reduce((s, e) => s + e.ms, 0) / triggered.length) : 0;
  console.log(
    `\nExpansion (${expandMode}): triggered on ${triggered.length}/${cases.length} questions ` +
      `(${triggered.filter((e) => e.reason === "non-english-query").length} non-English, ${triggered.filter((e) => e.reason === "weak-lexical-match").length} weak English); mean model time ${meanMs} ms when triggered`
  );
  rawExpandedMetrics = report("RAW + EXPANSION", rawExpanded);
  servedExpandedMetrics = report("SERVED + EXPANSION", servedExpanded);
}

if (args.includes("--misses")) {
  console.log("\nRaw misses (no relevant passage in the top " + RAW_DEPTH + "):");
  for (const r of raw.filter((x) => x.rank === null)) console.log(`  ${r.id.padEnd(26)} [${r.category}] top docs: ${r.topDocs.join(" | ") || "none"}`);
  console.log("\nRaw hits ranked below 5:");
  for (const r of raw.filter((x) => x.rank !== null && x.rank > 5)) console.log(`  ${r.id.padEnd(26)} [${r.category}] first relevant at rank ${r.rank}`);
  if (expandMode) {
    console.log("\nExpansion changed the raw outcome:");
    raw.forEach((r, i) => {
      if (r.rank !== rawExpanded[i].rank) console.log(`  ${r.id.padEnd(26)} [${r.category}] rank ${r.rank ?? "miss"} -> ${rawExpanded[i].rank ?? "miss"}   terms: ${expansions[r.id]?.terms ?? ""}`);
    });
  }
  console.log("\nServed misses where applicability changed the outcome:");
  for (const r of served.filter((x, i) => x.rank === null && raw[i].rank !== null)) console.log(`  ${r.id.padEnd(26)} applicability mode: ${modes[r.id]}`);
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ raw: rawMetrics, served: servedMetrics, rawExpanded: rawExpandedMetrics, servedExpanded: servedExpandedMetrics, cases: raw }, null, 2));

if (args.includes("--write-baseline")) {
  const out = { corpusChunks: index.n, gold: cases.length, raw: rawMetrics, served: servedMetrics, ...(rawExpandedMetrics ? { rawExpanded: rawExpandedMetrics, servedExpanded: servedExpandedMetrics } : {}) };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${BASELINE}`);
}

if (args.includes("--check")) {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { raw: Metrics; served: Metrics; rawExpanded?: Metrics; servedExpanded?: Metrics };
  const checks: [string, ReturnType<typeof compareToBaseline>][] = [
    ["raw", compareToBaseline(rawMetrics, baseline.raw)],
    ["served", compareToBaseline(servedMetrics, baseline.served)],
  ];
  if (rawExpandedMetrics && baseline.rawExpanded) checks.push(["raw+expansion", compareToBaseline(rawExpandedMetrics, baseline.rawExpanded)]);
  if (servedExpandedMetrics && baseline.servedExpanded) checks.push(["served+expansion", compareToBaseline(servedExpandedMetrics, baseline.servedExpanded)]);
  let failed = false;
  for (const [name, check] of checks) {
    if (!check.ok) {
      failed = true;
      for (const f of check.failures) console.error(`REGRESSION (${name}): ${f}`);
    }
  }
  if (failed) process.exit(1);
  console.log("\nNo regression against the baseline.");
}
