import { SKIP_WITHOUT_CORPUS } from "./helpers/corpus.ts";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { chunkDocument, type Chunk } from "../lib/ingestion/chunk.ts";
import type { NormalizedDocument } from "../lib/ingestion/normalize.ts";
import { buildIndex, search, type ScoredChunk } from "../lib/retrieval/index.ts";
import {
  AMBIGUOUS_TERMS,
  createRegionVocabulary,
  detectTaskContext,
  detectTaskRegions,
  parseAudience,
  parseRegionMetadata,
} from "../lib/applicability/regions.ts";
import { applyApplicability, classifyChunk, regionLabel, UNSPECIFIED_REGION_LABEL } from "../lib/applicability/evaluate.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { retrieveApplicable, OVER_FETCH_K, TOP_K } from "../lib/runtime/retrieveApplicable.ts";
import { formatApplicabilityLabel } from "../lib/runtime/citationBuilder.ts";

// Offline and deterministic: no model call. Region membership is deliberately
// NOT part of the built-in vocabulary (it awaits Content/Governance
// validation), so these tests use createRegionVocabulary() directly and never
// depend on a local data/region-membership.local.json.

const vocab = createRegionVocabulary(null);

function chunk(overrides: Partial<Chunk> & { id: string }): Chunk {
  return {
    documentId: overrides.id,
    documentTitle: `Doc ${overrides.id}`,
    heading: null,
    text: `text of ${overrides.id}`,
    citationUrl: null,
    citationUrlType: null,
    ...overrides,
  };
}

const globalChunk = (id: string) => chunk({ id, regions: ["Global"], regionScope: "global" });
const regionalChunk = (id: string, ...regions: string[]) => chunk({ id, regions, regionScope: "regional" });
const unspecifiedChunk = (id: string) => chunk({ id, regions: [], regionScope: "unspecified" });
const scored = (chunks: Chunk[]): ScoredChunk[] => chunks.map((c, i) => ({ chunk: c, score: 100 - i }));

describe("region metadata canonicalization (approved aliases only)", () => {
  test("Brazil / Brasil / BR -> Brazil", () => {
    for (const raw of ["Brazil", "Brasil", "BR", "br", " Brasil "]) {
      assert.deepEqual(parseRegionMetadata(vocab, raw), { regions: ["Brazil"], scope: "regional", unrecognized: [] }, raw);
    }
  });

  test("US / USA / U.S. / United States -> United States", () => {
    for (const raw of ["US", "USA", "U.S.", "United States"]) {
      assert.deepEqual(parseRegionMetadata(vocab, raw).regions, ["United States"], raw);
    }
  });

  test("SS Latam / SS-Latam / SSL -> SS Latam", () => {
    for (const raw of ["SS Latam", "SS-Latam", "SSL", "ss latam"]) {
      assert.deepEqual(parseRegionMetadata(vocab, raw).regions, ["SS Latam"], raw);
    }
  });

  test("multi-value metadata is split: 'US, SS-Latam' -> two regions", () => {
    const parsed = parseRegionMetadata(vocab, "US, SS-Latam");
    assert.deepEqual(parsed.regions, ["United States", "SS Latam"]);
    assert.equal(parsed.scope, "regional");
  });

  test("Global only when the metadata literally says Global", () => {
    assert.deepEqual(parseRegionMetadata(vocab, "Global"), { regions: ["Global"], scope: "global", unrecognized: [] });
    assert.equal(parseRegionMetadata(vocab, "global").scope, "global");
    assert.notEqual(parseRegionMetadata(vocab, "Worldwide").scope, "global");
    assert.notEqual(parseRegionMetadata(vocab, "All regions").scope, "global");
  });

  test("missing, empty or unrecognized region metadata is unspecified (never Global) and unrecognized tokens are reported", () => {
    for (const raw of [undefined, null, "", "   "]) assert.equal(parseRegionMetadata(vocab, raw).scope, "unspecified");
    const atlantis = parseRegionMetadata(vocab, "Atlantis");
    assert.equal(atlantis.scope, "unspecified");
    assert.deepEqual(atlantis.regions, []);
    assert.deepEqual(atlantis.unrecognized, ["Atlantis"]);
  });

  test("Europe is an approved region; EU / Europa are not approved aliases and stay unrecognized, never guessed", () => {
    assert.deepEqual(parseRegionMetadata(vocab, "Europe"), { regions: ["Europe"], scope: "regional", unrecognized: [] });
    for (const raw of ["EU", "Europa"]) {
      const parsed = parseRegionMetadata(vocab, raw);
      assert.equal(parsed.scope, "unspecified", raw);
      assert.deepEqual(parsed.unrecognized, [raw], raw);
    }
  });

  test("a country named in metadata resolves to its operating region", () => {
    assert.deepEqual(parseRegionMetadata(vocab, "Mexico").regions, ["SS Latam"]);
    assert.deepEqual(parseRegionMetadata(vocab, "Canada, US").regions, ["United States"]);
    assert.deepEqual(parseRegionMetadata(vocab, "UK, Spain").regions, ["Europe"]);
  });

  test("a mix of known and unknown tokens stays regional on the known ones and reports the rest", () => {
    const parsed = parseRegionMetadata(vocab, "US, Atlantis");
    assert.deepEqual(parsed, { regions: ["United States"], scope: "regional", unrecognized: ["Atlantis"] });
  });

  test("audience is split into label values only", () => {
    assert.deepEqual(parseAudience("Sales, CS, WE"), ["Sales", "CS", "WE"]);
    assert.deepEqual(parseAudience("Sales and Sales Dev"), ["Sales", "Sales Dev"]);
    assert.deepEqual(parseAudience(undefined), []);
  });
});

describe("approved operating-region map (Product, 2026-10-28)", () => {
  const regionOf = (text: string) => detectTaskContext(vocab, [text]);

  test("SS Latam = Mexico / México, Chile, Argentina", () => {
    for (const text of ["new client in Mexico", "cliente en México", "client in Chile", "cliente en Argentina"]) {
      assert.deepEqual(regionOf(text).regions, ["SS Latam"], text);
    }
  });

  test("Europe = UK / United Kingdom, Ireland, Spain / España, Germany, Romania, Italy, Portugal, Netherlands / Holland, France, Benelux", () => {
    const places = ["UK", "United Kingdom", "Ireland", "Spain", "España", "Germany", "Romania", "Italy", "Portugal", "Netherlands", "Holland", "France", "Benelux", "Europe"];
    for (const place of places) assert.deepEqual(regionOf(`a client in ${place}`).regions, ["Europe"], place);
  });

  test("Brazil / Brasil / BR resolve to Brazil", () => {
    for (const place of ["Brazil", "Brasil", "BR"]) assert.deepEqual(regionOf(`a client in ${place}`).regions, ["Brazil"], place);
  });

  test("country identity is kept separate from operating-region identity: Canada resolves to the United States region but is not the United States", () => {
    assert.deepEqual(regionOf("a client in Canada"), { regions: ["United States"], countries: ["Canada"] });
    assert.deepEqual(regionOf("a client in the US"), { regions: ["United States"], countries: ["United States"] });
    assert.deepEqual(regionOf("a client in Spain"), { regions: ["Europe"], countries: ["Spain"] });
  });

  test("Canada can diverge from the United States by editing the map alone, with no code change", () => {
    const diverged = createRegionVocabulary({ countries: { Canada: { region: "Canada" } } });
    assert.deepEqual(detectTaskContext(diverged, ["a client in Canada"]), { regions: ["Canada"], countries: ["Canada"] });
    assert.deepEqual(detectTaskContext(diverged, ["a client in the US"]).regions, ["United States"]);
    // A chunk tagged United States no longer matches a Canadian user once they diverge.
    assert.equal(classifyChunk(regionalChunk("r", "United States"), ["Canada"]), "mismatch");
  });

  test("'New Mexico' is not Mexico", () => {
    assert.deepEqual(regionOf("a client in New Mexico").regions, []);
    assert.deepEqual(regionOf("a client in new mexico and one in Mexico").regions, ["SS Latam"]);
  });

  test("umbrella terms and language names still never resolve, even next to approved places", () => {
    for (const text of ["client in LATAM", "client in EMEA", "client in Iberia", "cliente de habla hispana", "cliente em português"]) {
      assert.deepEqual(regionOf(text).regions, [], text);
    }
  });
});

describe("optional membership config (local override on top of the approved map)", () => {

  test("a config can add aliases and countries, and they then resolve", () => {
    const configured = createRegionVocabulary({
      regions: { "SS Latam": { countries: ["Colombia"] }, Europe: { aliases: ["EU"], countries: ["Poland"] } },
    });
    assert.deepEqual(detectTaskRegions(configured, ["client in Colombia"]), ["SS Latam"]);
    assert.deepEqual(detectTaskRegions(configured, ["client in Poland"]), ["Europe"]);
    assert.deepEqual(parseRegionMetadata(configured, "EU").regions, ["Europe"]);
    assert.deepEqual(configured.warnings, []);
  });

  test("a config cannot smuggle in ambiguous umbrella terms or language names", () => {
    const configured = createRegionVocabulary({
      regions: { "SS Latam": { aliases: ["LATAM", "Spanish"], countries: ["Iberia"] }, EMEA: { aliases: ["EMEA"] } },
    });
    assert.deepEqual(detectTaskRegions(configured, ["LATAM", "EMEA", "Iberia", "Spanish"]), []);
    assert.ok(configured.warnings.length >= 4, configured.warnings.join(" | "));
  });
});

describe("task-region detection", () => {
  test("detects approved aliases in the user's own words", () => {
    assert.deepEqual(detectTaskRegions(vocab, ["Tier 1 in Brazil"]), ["Brazil"]);
    assert.deepEqual(detectTaskRegions(vocab, ["cliente en Brasil"]), ["Brazil"]);
    assert.deepEqual(detectTaskRegions(vocab, ["the client is in the US"]), ["United States"]);
    assert.deepEqual(detectTaskRegions(vocab, ["this is an SSL account"]), ["SS Latam"]);
  });

  test("short all-caps aliases are case-sensitive: the pronoun 'us' is not a region", () => {
    assert.deepEqual(detectTaskRegions(vocab, ["can you give us the process, please"]), []);
    assert.deepEqual(detectTaskRegions(vocab, ["he said br because"]), []);
  });

  test("ambiguous umbrella terms and language names never resolve a region", () => {
    for (const term of AMBIGUOUS_TERMS) {
      assert.deepEqual(detectTaskRegions(vocab, [`my client is in ${term}`]), [], term);
    }
    assert.deepEqual(detectTaskRegions(vocab, ["necesito el proceso en español", "preciso do processo em português"]), []);
  });

  test("the most recent explicit mention wins", () => {
    assert.deepEqual(detectTaskRegions(vocab, ["client in the US", "actually it is in Brazil"]), ["Brazil"]);
    assert.deepEqual(detectTaskRegions(vocab, ["client in Brazil", "and what about the onboarding steps?"]), ["Brazil"]);
  });

  test("language is not a proxy for region: the same resolution in EN, ES and PT, and none when no region is stated", () => {
    for (const q of ["What is the onboarding for a client in Brazil?", "¿Cuál es el onboarding de un cliente en Brazil?", "Qual é o onboarding de um cliente no Brasil?"]) {
      assert.deepEqual(detectTaskRegions(vocab, [q]), ["Brazil"], q);
    }
    for (const q of ["What is the onboarding process in my region?", "¿Cuál es el proceso de onboarding del cliente en mi región?", "Qual é o processo de onboarding na minha região?"]) {
      assert.deepEqual(detectTaskRegions(vocab, [q]), [], q);
    }
  });
});

describe("chunk status classification: unspecified is never silently Global or a match", () => {
  test("statuses", () => {
    assert.equal(classifyChunk(globalChunk("g"), []), "global");
    assert.equal(classifyChunk(globalChunk("g"), ["Brazil"]), "global");
    assert.equal(classifyChunk(regionalChunk("r", "Brazil"), []), "unresolved");
    assert.equal(classifyChunk(regionalChunk("r", "Brazil"), ["Brazil"]), "match");
    assert.equal(classifyChunk(regionalChunk("r", "SS Latam", "United States"), ["United States"]), "match");
    assert.equal(classifyChunk(regionalChunk("r", "SS Latam"), ["Brazil"]), "mismatch");
  });

  test("a chunk without usable region metadata is unspecified for every task region, never global or match", () => {
    for (const task of [[], ["Brazil"], ["United States"], ["SS Latam"], ["Brazil", "United States"]]) {
      assert.equal(classifyChunk(unspecifiedChunk("u"), task), "unspecified", JSON.stringify(task));
    }
    // A chunk object with none of the new fields at all (legacy shape) is also unspecified.
    assert.equal(classifyChunk(chunk({ id: "legacy" }), ["Brazil"]), "unspecified");
  });

  test("a title that says US does not make a chunk regional or a match", () => {
    const slideLibrary = chunk({ id: "PMM _ Slide Library _ US _ DO NOT EDIT", regionScope: "unspecified", regions: [] });
    assert.equal(classifyChunk(slideLibrary, ["United States"]), "unspecified");
    assert.equal(regionLabel(slideLibrary), UNSPECIFIED_REGION_LABEL);
  });

  test("an unrecognized region token never becomes Global or a match", () => {
    const doc = documentWith({ targetRegion: "Atlantis" });
    const [c] = chunkDocument(doc, vocab);
    assert.equal(c.regionScope, "unspecified");
    assert.deepEqual(c.unrecognizedRegionTokens, ["Atlantis"]);
    assert.equal(classifyChunk(c, ["Brazil"]), "unspecified");
  });

  test("the visible and logged label is exact", () => {
    assert.equal(UNSPECIFIED_REGION_LABEL, "not specified in source metadata");
    assert.equal(regionLabel(unspecifiedChunk("u")), "not specified in source metadata");
    assert.equal(regionLabel(globalChunk("g")), "Global");
    assert.equal(regionLabel(regionalChunk("r", "SS Latam")), "SS Latam");
    assert.equal(formatApplicabilityLabel(unspecifiedChunk("u")), "region: not specified in source metadata");
  });
});

function documentWith(metadata: NormalizedDocument["metadata"]): NormalizedDocument {
  return {
    id: "DOC-1",
    title: "A document",
    sourceFilePath: "x.docx",
    sourceFormat: "docx",
    metadata,
    citationUrl: null,
    citationUrlType: null,
    usedTemplate: true,
    sections: [{ heading: "H", headingLevel: 1, text: "some text", order: 0 }],
    extractionWarnings: [],
  };
}

describe("metadata propagation to chunks", () => {
  test("region and audience reach every chunk, with the raw value kept", () => {
    const doc = documentWith({ targetRegion: "US, SS-Latam", targetAudience: "Sales, CS" });
    doc.sections.push({ heading: "H2", headingLevel: 1, text: "more text", order: 1 });
    const chunks = chunkDocument(doc, vocab);
    assert.equal(chunks.length, 2);
    for (const c of chunks) {
      assert.deepEqual(c.regions, ["United States", "SS Latam"]);
      assert.equal(c.regionScope, "regional");
      assert.equal(c.regionRaw, "US, SS-Latam");
      assert.deepEqual(c.audience, ["Sales", "CS"]);
    }
  });

  test("a document with no metadata (e.g. a PPTX) produces unspecified chunks, not Global", () => {
    const [c] = chunkDocument(documentWith({}), vocab);
    assert.equal(c.regionScope, "unspecified");
    assert.deepEqual(c.regions, []);
    assert.equal(c.audience, undefined);
  });
});

describe("applyApplicability", () => {
  test("Global content stays eligible with or without a known region", () => {
    for (const task of [[], ["Brazil"]]) {
      const d = applyApplicability(task, scored([globalChunk("g1"), globalChunk("g2")]), 5);
      assert.equal(d.mode, "none");
      assert.deepEqual(d.eligible.map((r) => r.chunk.id), ["g1", "g2"]);
    }
  });

  test("a matching regional chunk is eligible; a mismatched one never reaches the model", () => {
    const d = applyApplicability(["Brazil"], scored([regionalChunk("ssl", "SS Latam"), regionalChunk("br", "Brazil"), globalChunk("g")]), 5);
    assert.deepEqual(d.eligible.map((r) => r.chunk.id), ["br", "g"]);
    assert.equal(d.mismatchCount, 1);
    assert.deepEqual(d.mismatchRegions, ["SS Latam"]);
    assert.equal(d.mode, "none");
  });

  test("unknown region + top-ranked regional chunk -> must-clarify, no content is passed on", () => {
    const d = applyApplicability([], scored([regionalChunk("ssl1", "SS Latam"), regionalChunk("ssl2", "SS Latam"), globalChunk("g")]), 5);
    assert.equal(d.mode, "must-clarify");
    assert.deepEqual(d.eligible, []);
    assert.deepEqual(d.withheldRegions, ["SS Latam"]);
  });

  test("unknown region + only region-specific content -> must-clarify", () => {
    const d = applyApplicability([], scored([regionalChunk("a", "Brazil"), regionalChunk("b", "United States")]), 5);
    assert.equal(d.mode, "must-clarify");
    assert.deepEqual(d.withheldRegions.sort(), ["Brazil", "United States"]);
  });

  test("unknown region + best match is Global, regional content lower -> notice, Global answers", () => {
    const d = applyApplicability([], scored([globalChunk("g"), regionalChunk("ssl", "SS Latam")]), 5);
    assert.equal(d.mode, "notice");
    assert.deepEqual(d.eligible.map((r) => r.chunk.id), ["g"]);
    assert.deepEqual(d.withheldRegions, ["SS Latam"]);
  });

  test("known region + everything retrieved is for other regions -> no-applicable-content, no content passed on", () => {
    const d = applyApplicability(["Brazil"], scored([regionalChunk("a", "SS Latam"), regionalChunk("b", "United States")]), 5);
    assert.equal(d.mode, "no-applicable-content");
    assert.deepEqual(d.eligible, []);
    assert.deepEqual(d.mismatchRegions.sort(), ["SS Latam", "United States"]);
  });

  test("unspecified content is eligible, is counted, and never satisfies or triggers the region gate by itself", () => {
    const d = applyApplicability(["Brazil"], scored([unspecifiedChunk("u1"), unspecifiedChunk("u2")]), 5);
    assert.equal(d.mode, "none");
    assert.equal(d.unspecifiedUsed, 2);
    assert.deepEqual(d.eligibleStatuses, ["unspecified", "unspecified"]);
    const unknown = applyApplicability([], scored([unspecifiedChunk("u1")]), 5);
    assert.equal(unknown.mode, "none");
  });

  test("when the top-ranked chunk is region-specific and unresolved, unspecified content below it does not rescue the answer", () => {
    const d = applyApplicability([], scored([regionalChunk("ssl", "SS Latam"), unspecifiedChunk("u")]), 5);
    assert.equal(d.mode, "must-clarify");
    assert.deepEqual(d.eligible, []);
  });

  test("over-fetched candidates are filtered, then trimmed to topK in rank order", () => {
    const ranked = scored([
      regionalChunk("x1", "SS Latam"),
      regionalChunk("x2", "SS Latam"),
      globalChunk("g1"),
      globalChunk("g2"),
      globalChunk("g3"),
      globalChunk("g4"),
      globalChunk("g5"),
      globalChunk("g6"),
    ]);
    const d = applyApplicability(["Brazil"], ranked, 5);
    assert.deepEqual(d.eligible.map((r) => r.chunk.id), ["g1", "g2", "g3", "g4", "g5"]);
  });

  test("a low-ranked regional chunk outside the top-K window cannot force a question or a notice", () => {
    const ranked = scored([globalChunk("g1"), globalChunk("g2"), globalChunk("g3"), globalChunk("g4"), globalChunk("g5"), regionalChunk("late", "SS Latam")]);
    const d = applyApplicability([], ranked, 5);
    assert.equal(d.mode, "none");
    assert.equal(d.withheldCount, 0);
  });

  test("invariant: no eligible chunk is ever regional-and-not-matching, for any mix and any task region", () => {
    const pool = [globalChunk("g"), unspecifiedChunk("u"), regionalChunk("b", "Brazil"), regionalChunk("s", "SS Latam"), regionalChunk("m", "United States", "SS Latam")];
    const tasks = [[], ["Brazil"], ["SS Latam"], ["United States"], ["Brazil", "United States"]];
    for (const task of tasks) {
      for (let mask = 1; mask < 1 << pool.length; mask++) {
        const subset = pool.filter((_, i) => mask & (1 << i));
        const d = applyApplicability(task, scored(subset), 5);
        for (const r of d.eligible) {
          const status = classifyChunk(r.chunk, task);
          assert.ok(["global", "match", "unspecified"].includes(status), `${r.chunk.id} under ${JSON.stringify(task)} was ${status}`);
        }
      }
    }
  });
});

describe("prompt construction under the Applicability Layer", () => {
  const sslChunk = chunk({ id: "ssl", documentTitle: "[SSL] Onboarding", text: "SSL-ONLY-PROCESS-TEXT step one", regions: ["SS Latam"], regionScope: "regional", audience: ["Sales"] });

  test("must-clarify sends no retrieved content: the withheld text appears nowhere in the prompt", () => {
    const decision = applyApplicability([], scored([sslChunk]), 5);
    const prompt = buildPrompt("¿Cuál es el proceso de onboarding en mi región?", decision.eligible, [], decision);
    assert.ok(!prompt.includes("SSL-ONLY-PROCESS-TEXT"));
    assert.ok(!prompt.includes("Retrieved Knowledge"));
    assert.match(prompt, /Applicability gate -- mandatory/);
    assert.match(prompt, /CLARIFYING_QUESTION/);
    assert.match(prompt, /SS Latam/);
    assert.match(prompt, /language of the user's question/);
  });

  test("no-applicable-content sends no retrieved content and states the user's region", () => {
    const decision = applyApplicability(["Brazil"], scored([sslChunk]), 5);
    const prompt = buildPrompt("Which onboarding meetings do I run?", decision.eligible, [], decision);
    assert.ok(!prompt.includes("SSL-ONLY-PROCESS-TEXT"));
    assert.match(prompt, /The user's region is Brazil/);
    assert.match(prompt, /NO_GROUNDED_ANSWER/);
  });

  test("each eligible source carries a structured Applicability line", () => {
    const g = chunk({ id: "g", text: "GLOBAL TEXT", regions: ["Global"], regionScope: "global", audience: ["Sales", "CS"] });
    const decision = applyApplicability([], scored([g]), 5);
    const prompt = buildPrompt("q", decision.eligible, [], decision);
    assert.match(prompt, /Applicability: region=Global \| audience=Sales, CS/);
  });

  test("unspecified sources are labeled exactly and trigger the uncertainty notice", () => {
    const u = chunk({ id: "u", text: "SLIDE TEXT", regionScope: "unspecified", regions: [] });
    const decision = applyApplicability(["Brazil"], scored([u]), 5);
    const prompt = buildPrompt("q", decision.eligible, [], decision);
    assert.match(prompt, /Applicability: region=not specified in source metadata/);
    assert.match(prompt, /not Global and not confirmed for any region/);
    assert.match(prompt, /do not present the answer as confirmed for the user's region \(Brazil\)/);
  });

  test("no notice about unspecified scope appears when no unspecified source is used", () => {
    const g = globalChunk("g");
    const prompt = buildPrompt("q", applyApplicability([], scored([g]), 5).eligible, [], applyApplicability([], scored([g]), 5));
    assert.ok(!prompt.includes("not Global and not confirmed for any region"));
  });

  test("the notice mode names the withheld regions without including their text", () => {
    const g = chunk({ id: "g", text: "GLOBAL TEXT", regions: ["Global"], regionScope: "global" });
    const decision = applyApplicability([], scored([g, sslChunk]), 5);
    const prompt = buildPrompt("q", decision.eligible, [], decision);
    assert.match(prompt, /Region-specific material for SS Latam was withheld/);
    assert.ok(!prompt.includes("SSL-ONLY-PROCESS-TEXT"));
  });

  test("buildPrompt without a decision behaves as before (backward compatible)", () => {
    const g = globalChunk("g");
    const prompt = buildPrompt("q", scored([g]), []);
    assert.ok(!prompt.includes("Applicability:"));
    assert.match(prompt, /Retrieved Knowledge:/);
  });

  test("the system prompt explains the labels and forbids treating unspecified as Global", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /region=Global means the source metadata explicitly says/);
    assert.match(HUBI_SYSTEM_PROMPT, /region=not specified in source metadata means its regional scope is UNKNOWN: it is not Global/);
    assert.match(HUBI_SYSTEM_PROMPT, /never treat "not specified" as Global/);
    assert.match(HUBI_SYSTEM_PROMPT, /Applicability gate -- mandatory/);
  });
});

// ---- Real-corpus regressions (Findings #001 and #002). No model call. ----

describe("real corpus: Findings #001 / #002 applicability scenarios", { skip: SKIP_WITHOUT_CORPUS }, () => {
  const { chunks } = ingestContentRepository("Content Repository");
  const index = buildIndex(chunks);

  const run = (userMessages: string[], v = vocab) => {
    const query = userMessages.join(" ");
    return { query, ...retrieveApplicable(index, query, userMessages, { vocabulary: v }) };
  };

  const eligibleIsSafe = (result: ReturnType<typeof run>) => {
    for (const r of result.decision.eligible) {
      const status = classifyChunk(r.chunk, result.decision.taskRegions);
      assert.ok(["global", "match", "unspecified"].includes(status), `${r.chunk.documentId} was ${status}`);
    }
  };

  test("retrieval itself is unchanged: the raw ranking equals a plain search over-fetch", () => {
    const q = "What is the onboarding process for a new client?";
    assert.deepEqual(
      run([q]).raw.map((r) => r.chunk.id),
      search(index, q, OVER_FETCH_K).map((r) => r.chunk.id)
    );
    assert.equal(TOP_K, 5);
  });

  test("#002 scenario 2 (Spanish, no region): must-clarify, SS Latam is named, and none of its text reaches the prompt", () => {
    const q = "¿Cuál es el proceso de onboarding del cliente en mi región?";
    const result = run([q]);
    assert.equal(result.decision.mode, "must-clarify");
    assert.deepEqual(result.decision.eligible, []);
    assert.ok(result.decision.withheldRegions.includes("SS Latam"));
    const prompt = buildPrompt(q, result.decision.eligible, [], result.decision);
    for (const r of result.raw.slice(0, TOP_K)) {
      const sample = r.chunk.text.replace(/\s+/g, " ").trim().slice(0, 60);
      assert.ok(sample.length < 20 || !prompt.replace(/\s+/g, " ").includes(sample), `withheld text leaked: ${sample}`);
    }
  });

  test("#001 multi-turn with Brazil: the SS Latam onboarding document is excluded, never eligible", () => {
    const result = run(["What meetings do I have to do for client onboarding?", "Tier 1 in Brazil"]);
    assert.deepEqual(result.decision.taskRegions, ["Brazil"]);
    assert.ok(result.decision.eligible.every((r) => r.chunk.documentId !== "RKC-000006"));
    eligibleIsSafe(result);
  });

  test("#001 multi-turn with Mexico: Mexico is SS Latam, so the SS Latam document matches; Brazil does not", () => {
    const result = run(["What meetings do I have to do for client onboarding?", "Tier 1 in Mexico"]);
    assert.deepEqual(result.decision.taskRegions, ["SS Latam"]);
    assert.deepEqual(result.decision.taskCountries, ["Mexico"]);
    eligibleIsSafe(result);
  });

  test("with a (hypothetical) validated config, Mexico resolves to SS Latam and the SS Latam document is eligible", () => {
    const configured = createRegionVocabulary({ regions: { "SS Latam": { countries: ["Mexico"] } } });
    const result = run(["¿Qué reuniones de onboarding debo hacer para el cliente de Mexico?"], configured);
    assert.deepEqual(result.decision.taskRegions, ["SS Latam"]);
    assert.ok(result.decision.eligible.some((r) => r.chunk.documentId === "RKC-000006"));
    eligibleIsSafe(result);
  });

  test("#002 scenario 1 (English, Brazil stated): no incompatible regional chunk reaches the model", () => {
    const result = run(["How do I onboard a new client in Brazil without Salesforce?"]);
    assert.deepEqual(result.decision.taskRegions, ["Brazil"]);
    eligibleIsSafe(result);
  });

  test("#002 scenario 3 (Portuguese, no region): Brazil-tagged chunks are not passed on as the answer", () => {
    const result = run(["Como faço para criar cadências eficazes no Salesloft?"]);
    eligibleIsSafe(result);
    assert.ok(result.decision.eligible.every((r) => r.chunk.regionScope !== "regional"));
  });

  test("#002 scenario 4 (no region, Global answer available): Global content is not forced into a clarifying question", () => {
    const result = run(["What is the onboarding process for a new client?"]);
    assert.notEqual(result.decision.mode, "must-clarify");
    assert.ok(result.decision.eligible.length > 0);
    eligibleIsSafe(result);
  });

  test("invariant over many questions and every task region: eligible content is always safe", () => {
    const questions = [
      "What meetings do I have to do for client onboarding?",
      "¿Cuál es el proceso de onboarding del cliente en mi región?",
      "How do I create effective cadences in Salesloft?",
      "Opportunity best practices",
      "Launch readiness in Salesforce",
      "competition training",
      "Write me an elevator pitch.",
      "client segmentation contract adherence",
    ];
    const regionStatements = ["", " in Brazil", " in the US", " for an SSL client"];
    for (const q of questions) {
      for (const suffix of regionStatements) {
        const messages = [q + suffix];
        eligibleIsSafe(run(messages));
      }
    }
  });

  test("unspecified is never silently Global or a match on real content (PMM Slide Library is titled 'US' but unspecified)", () => {
    const slides = chunks.filter((c) => c.documentId.startsWith("PMM _ Slide Library"));
    assert.ok(slides.length > 100);
    for (const c of slides) {
      assert.equal(c.regionScope, "unspecified");
      for (const task of [[], ["United States"], ["Brazil"]]) assert.equal(classifyChunk(c, task), "unspecified");
    }
    assert.ok(chunks.filter((c) => c.regionScope === "global").every((c) => (c.regionRaw ?? "").toLowerCase().includes("global")));
  });

  test("canonicalization of the real corpus' region values", () => {
    const byDoc = new Map(chunks.map((c) => [c.documentId, c]));
    assert.deepEqual(byDoc.get("RKC-000018")?.regions, ["Brazil"]);
    assert.deepEqual(byDoc.get("RKC-000027")?.regions, ["Brazil"]);
    assert.deepEqual(byDoc.get("RKC-000006")?.regions, ["SS Latam"]);
    assert.deepEqual(byDoc.get("RKC-000023")?.regions, ["United States", "SS Latam"]);
    assert.equal(byDoc.get("RKC-000002")?.regionScope, "global");
  });
});

describe("region cue: the user says the answer depends on their own region", () => {
  test("detects the cue in English, Spanish and Portuguese, and nothing else", async () => {
    const { refersToOwnRegion } = await import("../lib/applicability/regions.ts");
    for (const text of ["What is the process in my region?", "in my country", "¿Cuál es el proceso en mi región?", "en nuestro país", "Qual é o processo na minha região?"]) {
      assert.equal(refersToOwnRegion(text), true, text);
    }
    for (const text of ["What is the onboarding process?", "the region is Brazil", "a client in Mexico", "¿Cuál es el proceso de onboarding?"]) {
      assert.equal(refersToOwnRegion(text), false, text);
    }
  });

  test("with the cue, an unresolved region and withheld regional content, clarification is mandatory even when Global content ranks first", () => {
    const ranked = scored([globalChunk("g"), regionalChunk("ssl", "SS Latam")]);
    assert.equal(applyApplicability([], ranked, 5).mode, "notice");
    const cued = applyApplicability([], ranked, 5, { regionCue: true });
    assert.equal(cued.mode, "must-clarify");
    assert.deepEqual(cued.eligible, []);
  });

  test("the cue does nothing when the region is known or nothing regional was withheld", () => {
    assert.equal(applyApplicability(["Brazil"], scored([globalChunk("g"), regionalChunk("ssl", "SS Latam")]), 5, { regionCue: true }).mode, "none");
    assert.equal(applyApplicability([], scored([globalChunk("g")]), 5, { regionCue: true }).mode, "none");
  });

  test("real corpus: 'in my region' with no region stated clarifies; the same question without the cue does not force it", { skip: SKIP_WITHOUT_CORPUS }, () => {
    const { chunks } = ingestContentRepository("Content Repository");
    const index = buildIndex(chunks);
    const cued = retrieveApplicable(index, "What is the process for onboarding a new client in my region?", ["What is the process for onboarding a new client in my region?"], { vocabulary: vocab });
    assert.equal(cued.decision.mode, "must-clarify");
    const plain = retrieveApplicable(index, "What is the onboarding process for a new client?", ["What is the onboarding process for a new client?"], { vocabulary: vocab });
    assert.notEqual(plain.decision.mode, "must-clarify");
  });
});
