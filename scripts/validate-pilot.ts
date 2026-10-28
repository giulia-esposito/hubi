/**
 * Real-corpus validation gate for the stakeholder pilot build. Runs the checks
 * A-J through the real pipeline (governed index, two-pass retrieval,
 * Applicability Layer, prompt, the configured provider) and prints, per check:
 * the retrieved sources with their region labels and which pass produced them,
 * the applicability and fact-pass decisions, planningMode, turnKind, latency,
 * the full answer, and automatic flags.
 *
 * Flags are heuristics to point a reviewer at problems; the outputs are meant
 * to be read. Calls a live model; not part of `npm test`.
 *
 *   GOOGLE_CLOUD_PROJECT=<project> HUBI_REASONING_PROVIDER=gemini \
 *   EVAL_RUNS=1 node --experimental-strip-types scripts/validate-pilot.ts [A|B|...|J]
 */
import { resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { converse, loadCorpus, type TurnResult } from "./lib/liveConversation.ts";
import { checkUngroundedFigures, checkUnsupportedValueLanguage } from "./lib/claimFidelityChecks.ts";

const corpus = loadCorpus();

type Flag = (turns: TurnResult[]) => string | null;
const last = (t: TurnResult[]) => t[t.length - 1];

const mode = (expected: string): Flag => (t) => (last(t).planningMode === expected ? null : `planningMode ${last(t).planningMode}, expected ${expected}`);
const kindNot = (kind: string): Flag => (t) => (last(t).turnKind === kind ? `turnKind is ${kind}` : null);
const kindIs = (kind: string): Flag => (t) => (last(t).turnKind === kind ? null : `turnKind ${last(t).turnKind}, expected ${kind}`);
const gate = (expected: string): Flag => (t) => (last(t).mode === expected ? null : `applicability mode ${last(t).mode}, expected ${expected}`);
const noRkc21: Flag = (t) => (t.some((x) => x.sources.some((s) => s.documentId === "RKC-000021")) ? "RKC-000021 (Not Eligible) is among the sources" : null);
const noUngroundedFigures: Flag = (t) => {
  const v = checkUngroundedFigures(last(t).text, last(t).sources.map((s) => s.text)).violations;
  return v.length ? `figure(s) not in the retrieved sources: ${v.map((x) => x.split(' ("')[1]?.split('")')[0] ?? x).join(", ")}` : null;
};
const noUnsupportedValueLanguage: Flag = (t) => {
  const v = checkUnsupportedValueLanguage(last(t).text, last(t).sources.map((s) => s.text)).violations;
  return v.length ? `value language not in the sources: ${v.map((x) => x.split(' ("')[1]?.split('")')[0] ?? x).join(", ")}` : null;
};
const noPlaceholders: Flag = (t) =>
  /(^|[^a-z])X\s?%|\[\s*\*{0,2}(insert|mention|state|provide|add|your|client name|company name)/i.test(last(t).text) ? "contains placeholders / a fill-in-the-blank template" : null;
const finished: Flag = (t) => (last(t).text.length >= 300 && !/(cannot|can't|unable to) (create|write|provide)|do(es)? not contain (a |an )?(pre-?written|specific)/i.test(last(t).text) ? null : "not a finished artifact (too short or says it cannot create it)");
// Product-scoped material must not read as a general claim: flag D2E-specific wording when the request never mentions it.
const noScopedLeak: Flag = (t) => {
  const asked = t.map((x) => x.question).join(" ");
  if (/d2e|direct-to-employee/i.test(asked)) return null;
  return /direct-to-employee|\bD2E\b|\b120%|\b320%/i.test(last(t).text) ? "D2E-specific wording presented in a generic answer" : null;
};
const region = (expected: string): Flag => (t) => (last(t).taskRegions.includes(expected) ? null : `task region ${JSON.stringify(last(t).taskRegions)}, expected ${expected}`);
const country = (expected: string): Flag => (t) => (last(t).taskCountries.includes(expected) ? null : `task country ${JSON.stringify(last(t).taskCountries)}, expected ${expected}`);
const noRegionResolved: Flag = (t) => (last(t).taskRegions.length === 0 ? null : `resolved a region: ${JSON.stringify(last(t).taskRegions)}`);
const noIncompatible: Flag = (t) => {
  const bad = last(t).sources.filter((s) => s.status === "mismatch" || s.status === "unresolved");
  return bad.length ? "incompatible/unresolved regional source reached the model" : null;
};
const noCitation = (needle: string, why: string): Flag => (t) => (last(t).sources.some((s) => s.citation.includes(needle)) ? why : null);
const SSL_PROCESS = /\bM[0-2]\b|kick[ -]?off|health checkpoint|paso a paso/i;
const noRegionalProcessText: Flag = (t) => (SSL_PROCESS.test(last(t).text) ? "answer contains SS Latam process content" : null);
const asksRegion: Flag = (t) => (/region|región|regi[oã]o/i.test(last(t).text) && /[?¿]/.test(last(t).text) ? null : "does not ask about the region");

interface Check {
  id: string;
  label: string;
  turns: string[];
  flags: Flag[];
}

const BASELINE: Flag[] = [noRkc21, noIncompatible];

const CHECKS: Check[] = [
  {
    id: "A",
    label: "Business Assistance: generic pitch",
    turns: ["Write me an elevator pitch."],
    flags: [...BASELINE, mode("business-assistance"), finished, noPlaceholders, noUngroundedFigures, noUnsupportedValueLanguage, noScopedLeak, kindNot("no-grounded-answer")],
  },
  {
    id: "B",
    label: "Business Assistance: pitch to a prospect",
    turns: ["How can I present Wellhub to a prospect? Write a 1-min elevator pitch."],
    flags: [...BASELINE, mode("business-assistance"), finished, noPlaceholders, noUngroundedFigures, noUnsupportedValueLanguage, noScopedLeak, kindNot("no-grounded-answer")],
  },
  {
    id: "C",
    label: "Business Assistance: follow-up tailoring (financial industry, enterprise)",
    turns: ["How can I present Wellhub to a prospect? Write a 1-min elevator pitch.", "A company from the financial industry, enterprise size."],
    flags: [...BASELINE, mode("business-assistance"), finished, noPlaceholders, noUngroundedFigures, noUnsupportedValueLanguage, noScopedLeak, kindNot("no-grounded-answer")],
  },
  {
    id: "D",
    label: "Knowledge Retrieval: existence question",
    turns: ["Do we have an elevator pitch?"],
    flags: [...BASELINE, mode("knowledge-retrieval"), noScopedLeak],
  },
  {
    id: "E",
    label: "Brazil operational process",
    turns: ["How do I create and manage an opportunity in Salesforce for a client in Brazil?"],
    flags: [...BASELINE, region("Brazil"), noCitation("[SSL]", "cites the SS Latam document for a Brazil client"), noCitation("US & SSL", "cites the US/SS Latam training for a Brazil client")],
  },
  {
    id: "F",
    label: "US operational process",
    turns: ["As a rep covering a client in the US, how should I handle the competition?"],
    flags: [...BASELINE, region("United States"), noCitation("[SSL]", "cites an SS Latam-only document for a US client"), noCitation("Opportunity Best Practices - BR", "cites a Brazil-only document for a US client")],
  },
  {
    id: "G",
    label: "UK / Europe operational process",
    turns: ["I have a new client in the UK. What meetings do I run for onboarding?"],
    flags: [...BASELINE, region("Europe"), country("United Kingdom"), noRegionalProcessText, noCitation("[SSL]", "cites the SS Latam document for a UK client")],
  },
  {
    id: "H",
    label: "SS Latam operational process (Mexico)",
    turns: ["Tengo un cliente nuevo en México. ¿Qué reuniones de onboarding tengo que hacer?"],
    flags: [...BASELINE, region("SS Latam"), country("Mexico"), kindNot("clarifying-question")],
  },
  {
    id: "I",
    label: "Ambiguous regional question, no region supplied",
    turns: ["What is the process for onboarding a new client in my region?"],
    flags: [...BASELINE, noRegionResolved, gate("must-clarify"), kindIs("clarifying-question"), asksRegion, noRegionalProcessText],
  },
  {
    id: "J",
    label: "Canada (operates as the US region for the prototype)",
    turns: ["I have a client in Canada. How should I handle the competition?"],
    flags: [...BASELINE, region("United States"), country("Canada"), noCitation("[SSL]", "cites an SS Latam-only document for a Canada client"), noCitation("Opportunity Best Practices - BR", "cites a Brazil-only document for a Canada client")],
  },
];

function describeSources(r: TurnResult, passOneCount: number): string {
  return r.sources
    .map((s, i) => `    [${i + 1}] ${i < passOneCount ? "pass 1" : "pass 2"} | region: ${s.region} (${s.status}) | ${s.citation.replace(/ \(no link available\)$/, "")}`)
    .join("\n");
}

async function main() {
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const only = process.argv[2]?.toUpperCase();
  const checks = only ? CHECKS.filter((c) => c.id === only) : CHECKS;
  console.log(`Pilot validation (real corpus) -- provider: ${resolveReasoningProvider()}, runs per check: ${runs}`);
  for (const e of corpus.excluded) console.log(`Excluded by AI Eligibility (${e.aiEligibility}): ${e.contentId} (${e.chunkCount} chunks)`);
  console.log("");

  const summary: string[] = [];
  for (const c of checks) {
    console.log(`=== ${c.id}. ${c.label}`);
    c.turns.forEach((t, i) => console.log(`    turn ${i + 1}: ${t}`));
    let clean = 0;
    const latencies: { retrieval: number; model: number; total: number }[] = [];
    for (let i = 0; i < runs; i++) {
      let turns: TurnResult[];
      try {
        turns = await converse(corpus, c.turns);
      } catch (err) {
        console.log(`--- run ${i + 1}: ERROR ${String((err as Error).message ?? err).slice(0, 160)}`);
        continue;
      }
      const r = last(turns);
      const flags = c.flags.map((f) => f(turns)).filter((f): f is string => f !== null);
      if (flags.length === 0) clean++;
      latencies.push({ retrieval: r.retrievalMs, model: r.modelMs, total: r.totalMs });
      console.log(
        `--- run ${i + 1}: ${flags.length === 0 ? "CLEAN" : "FLAGGED"} [planningMode: ${r.planningMode}] [turnKind: ${r.turnKind}] [gate: ${r.mode}] ` +
          `[region: ${r.taskRegions.join(", ") || "unknown"}${r.taskCountries.length ? " / country: " + r.taskCountries.join(", ") : ""}]`
      );
      console.log(`    latency: retrieval ${r.retrievalMs.toFixed(1)} ms | model ${(r.modelMs / 1000).toFixed(1)} s | turn ${(r.totalMs / 1000).toFixed(1)} s`);
      console.log(
        `    fact pass: ${r.factPass.triggered ? `triggered, +${r.factPass.added} chunk(s), query: ${r.factPass.query}` : `not run (${r.factPass.reason})`}`
      );
      const v = r.verification;
      console.log(
        v.buffered
          ? `    claim guardrail (pilot): buffered | checked ${v.checked} | violations ${v.violationsBefore} -> ${v.violationsAfter}` +
              (v.revised ? ` | revised (${v.revisionAccepted ? "accepted" : "discarded"}, +${(v.extraMs / 1000).toFixed(1)}s) | flagged: ${v.phrases.join(", ")}` : "")
          : "    claim guardrail (pilot): not buffered (streams normally)"
      );
      if (r.withheldRegions.length) console.log(`    withheld (region unknown): ${r.withheldRegions.join(", ")}`);
      if (r.mismatchRegions.length) console.log(`    excluded (other region): ${r.mismatchRegions.join(", ")}`);
      const passOneCount = r.factPass.triggered ? r.sources.length - r.factPass.added : r.sources.length;
      console.log(r.sources.length ? `    sources the model saw:\n${describeSources(r, passOneCount)}` : "    sources the model saw: none");
      for (const f of flags) console.log(`    ! ${f}`);
      if (i === 0 || process.env.SHOW_ALL === "1") console.log(r.text.split("\n").map((l) => `    | ${l}`).join("\n"));
    }
    const avg = (key: "retrieval" | "model" | "total") => (latencies.length ? latencies.reduce((a, l) => a + l[key], 0) / latencies.length : 0);
    console.log(`=== ${c.id}: ${clean}/${runs} clean\n`);
    summary.push(`${c.id}  ${c.label.padEnd(66)} ${clean}/${runs} clean | retrieval ${avg("retrieval").toFixed(1)} ms | model ${(avg("model") / 1000).toFixed(1)} s | turn ${(avg("total") / 1000).toFixed(1)} s`);
  }
  console.log("=== SUMMARY");
  for (const line of summary) console.log(line);
}

main();
