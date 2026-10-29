import { SKIP_WITHOUT_CORPUS } from "./helpers/corpus.ts";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { applyGovernance, describeGovernance, normalizeAccessLevel, PILOT_GOVERNANCE_POLICY } from "../lib/governance/governance.ts";
import { decideEntry, normalizeEligibility, parseRegistryCsv, validateSnapshot, type RegistrySnapshot } from "../lib/governance/registry.ts";
import { REGISTRY_SNAPSHOT } from "../lib/governance/registrySnapshot.ts";
import { renderSnapshotModule } from "../lib/governance/snapshotModule.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import { search } from "../lib/retrieval/index.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";
import { applyApplicability } from "../lib/applicability/evaluate.ts";
import { createRegionVocabulary, detectTaskRegions } from "../lib/applicability/regions.ts";
import { formatCitation } from "../lib/runtime/citationBuilder.ts";

// The registry decides, not a list in the code: eligibility, retirement and
// restrictions all come from the compiled snapshot of the Content Registry.
// AI Eligibility is a governance gate, not a retrieval optimization (Finding
// #002): content the registry rules out must never reach retrieval, prompts,
// citations or logs. Deterministic; no model call.

function chunk(documentId: string, id: string): Chunk {
  return { id, documentId, documentTitle: documentId, heading: null, text: `text ${id}`, citationUrl: null, citationUrlType: null };
}

const ids = (chunks: Chunk[]) => chunks.map((c) => c.id);

const REGISTRY: RegistrySnapshot = {
  source: "test",
  sourceRevision: "test",
  syncedAt: "2026-01-01",
  entries: [
    { contentId: "RKC-000001", aiEligibility: "Eligible", contentStatus: "Active", region: "Global", risks: [], contentType: "Training", collection: "", accessLevel: "Revenue – All", sourceModified: "" },
    { contentId: "RKC-000002", aiEligibility: "Not Eligible", contentStatus: "Active", region: "Global", risks: [], contentType: "Training", collection: "", accessLevel: "Revenue – All", sourceModified: "" },
    { contentId: "RKC-000003", aiEligibility: "Pending Assessment", contentStatus: "Active", region: "Global", risks: [], contentType: "Training", collection: "", accessLevel: "Revenue – All", sourceModified: "" },
    { contentId: "RKC-000004", aiEligibility: "Unassessed", contentStatus: "", region: "", risks: [], contentType: "Training", collection: "", accessLevel: "Revenue – All", sourceModified: "" },
    { contentId: "RKC-000005", aiEligibility: "Eligible", contentStatus: "Archived", region: "Global", risks: ["Outdated Content"], contentType: "Training", collection: "", accessLevel: "Revenue – All", sourceModified: "" },
    { contentId: "RKC-000006", aiEligibility: "Eligible with Restrictions", contentStatus: "Active", region: "Global", risks: ["Incomplete Content"], restriction: "Only released for US", contentType: "Training", collection: "", accessLevel: "Revenue – All", sourceModified: "" },
  ],
};

describe("registry decisions", () => {
  test("only Eligible and Eligible with Restrictions pass, and only while not retired", () => {
    const decide = (aiEligibility: string, contentStatus = "Active") =>
      decideEntry({ contentId: "RKC-000001", aiEligibility: normalizeEligibility(aiEligibility), contentStatus, region: "", risks: [], contentType: "", collection: "", accessLevel: "", sourceModified: "" }).allowed;
    assert.equal(decide("Eligible"), true);
    assert.equal(decide("Eligible with Restrictions"), true);
    assert.equal(decide("Not Eligible"), false);
    assert.equal(decide("Pending Assessment"), false);
    assert.equal(decide(""), false);
    assert.equal(decide("something new"), false);
    assert.equal(decide("Eligible", "Archived"), false);
    assert.equal(decide("Eligible", "Deprecated"), false);
  });

  test("a blank or unrecognized AI Eligibility is Unassessed, never eligible", () => {
    assert.equal(normalizeEligibility(undefined), "Unassessed");
    assert.equal(normalizeEligibility("  "), "Unassessed");
    assert.equal(normalizeEligibility("eligible "), "Eligible");
  });
});

describe("governance gate (synthetic registry)", () => {
  const chunks = [
    chunk("RKC-000001", "a"),
    chunk("RKC-000002", "b"),
    chunk("RKC-000003", "c"),
    chunk("RKC-000004", "d"),
    chunk("RKC-000005", "e"),
    chunk("RKC-000006", "f"),
    chunk("RKC-000099", "g"),
    chunk("Golden Pitch", "h"),
  ];
  const result = applyGovernance(chunks, { registry: REGISTRY });

  test("Not Eligible, Pending, Unassessed and retired documents are removed; each reports why", () => {
    assert.deepEqual(ids(result.chunks), ["a", "f", "h"]);
    const reasons = Object.fromEntries(result.excluded.map((e) => [e.contentId, e.reason]));
    assert.match(reasons["RKC-000002"], /Not Eligible/);
    assert.match(reasons["RKC-000003"], /Pending Assessment/);
    assert.match(reasons["RKC-000004"], /Unassessed/);
    assert.match(reasons["RKC-000005"], /Archived/);
  });

  test("a registry-format identifier the registry does not list is excluded (fail closed)", () => {
    assert.ok(result.excluded.some((e) => e.contentId === "RKC-000099"));
    assert.ok(!ids(result.chunks).includes("g"));
  });

  test("a file with no registry identifier is kept under the pilot policy, flagged unregistered", () => {
    assert.ok(ids(result.chunks).includes("h"));
    assert.deepEqual(result.report.unregistered.map((u) => u.documentId), ["Golden Pitch"]);
    assert.equal(result.chunks.find((c) => c.id === "h")?.governance?.status, "unregistered");
  });

  test("the policy can exclude unregistered files without touching registered ones", () => {
    const strict = applyGovernance(chunks, { registry: REGISTRY, policy: { ...PILOT_GOVERNANCE_POLICY, unregistered: "exclude" } });
    assert.deepEqual(ids(strict.chunks), ["a", "f"]);
  });

  test("a restricted document stays, carrying the registry's caveat on its chunks", () => {
    const f = result.chunks.find((c) => c.id === "f");
    assert.equal(f?.governance?.restriction, "Only released for US");
    assert.deepEqual(result.report.restricted, [{ contentId: "RKC-000006", restriction: "Only released for US", chunkCount: 1 }]);
  });

  test("the report accounts for every chunk", () => {
    assert.equal(result.report.chunksIn, chunks.length);
    assert.equal(result.report.chunksKept, result.chunks.length);
    assert.equal(result.report.chunksIn - result.report.chunksKept, result.excluded.reduce((n, e) => n + e.chunkCount, 0));
    assert.ok(describeGovernance(result.report).some((l) => l.includes("excluded RKC-000002")));
  });

  test("a change in the registry changes the outcome with no code change", () => {
    const flipped: RegistrySnapshot = { ...REGISTRY, entries: REGISTRY.entries.map((e) => (e.contentId === "RKC-000002" ? { ...e, aiEligibility: "Eligible" } : e)) };
    assert.ok(ids(applyGovernance(chunks, { registry: flipped }).chunks).includes("b"));
  });

  test("a registry region that disagrees with the document's own metadata is reported as drift, not resolved", () => {
    const withRegion: Chunk = { ...chunk("RKC-000001", "r"), regionRaw: "Brazil" };
    const drifted = applyGovernance([withRegion], {
      registry: { ...REGISTRY, entries: [{ ...REGISTRY.entries[0], region: "Europe" }] },
      vocabulary: createRegionVocabulary(null),
    });
    assert.deepEqual(drifted.report.drift, [{ contentId: "RKC-000001", field: "region", registry: "Europe", document: "Brazil" }]);
    assert.equal(drifted.chunks.length, 1);
  });
});

describe("registry export and snapshot", () => {
  const CSV =
    '"Identity"\n"Content ID","Region / Country\n(multi-select)","Content Status","AI Eligibility","Issues / Risks\n(multi-select)","Notes"\n' +
    'RKC-000001,Global,Active,Eligible,,\n' +
    'RKC-000002,"United States, Europe",Active,Eligible with Restrictions,"Broken Link, Other","Only US, mixed ""languages"""\n' +
    "RKC-000003,,,,,\n";

  test("parses the sheet layout: group header row, multi-line headers, quoted commas and quotes", () => {
    const { entries, warnings } = parseRegistryCsv(CSV);
    assert.equal(entries.length, 3);
    assert.equal(entries[1].region, "United States, Europe");
    assert.deepEqual(entries[1].risks, ["Broken Link", "Other"]);
    assert.equal(entries[1].restriction, 'Only US, mixed "languages"');
    assert.equal(entries[2].aiEligibility, "Unassessed");
    assert.ok(warnings.some((w) => w.includes("RKC-000003")));
  });

  test("rejects an export with duplicate identifiers, no header, or no entries", () => {
    assert.throws(() => parseRegistryCsv("Content ID,AI Eligibility,Content Status\nRKC-000001,Eligible,Active\nRKC-000001,Eligible,Active\n"), /more than once/);
    assert.throws(() => parseRegistryCsv("a,b\n1,2\n"), /Content ID/);
    assert.throws(() => parseRegistryCsv("Content ID,AI Eligibility,Content Status\n"), /no RKC entries/);
  });

  test("the compiled snapshot is valid and in step with the reviewed export", () => {
    assert.deepEqual(validateSnapshot(REGISTRY_SNAPSHOT), []);
    const { entries } = parseRegistryCsv(readFileSync("config/governance/registry-export.csv", "utf8"));
    assert.equal(renderSnapshotModule({ ...REGISTRY_SNAPSHOT, entries }).trim(), renderSnapshotModule(REGISTRY_SNAPSHOT).trim());
  });

  test("RKC-000021 is Not Eligible in the snapshot and so excluded without being named in code", () => {
    assert.equal(REGISTRY_SNAPSHOT.entries.find((e) => e.contentId === "RKC-000021")?.aiEligibility, "Not Eligible");
    const out = applyGovernance([chunk("RKC-000021", "x"), chunk("RKC-000002", "y")]);
    assert.deepEqual(ids(out.chunks), ["y"]);
  });

  test("a snapshot with no entries or a bad date is refused", () => {
    assert.ok(validateSnapshot({ ...REGISTRY, entries: [] }).length > 0);
    assert.ok(validateSnapshot({ ...REGISTRY, syncedAt: "yesterday" }).length > 0);
  });
});

describe("real corpus: Not Eligible content never reaches retrieval or reasoning", { skip: SKIP_WITHOUT_CORPUS }, () => {
  const { chunks } = ingestContentRepository("Content Repository");
  const rkc21 = chunks.filter((c) => c.documentId === "RKC-000021");
  const { index, excluded, report } = buildGovernedIndex(chunks);

  test("raw ingestion is still a full inventory, and the governed index drops exactly RKC-000021", () => {
    assert.equal(rkc21.length, 4);
    assert.equal(index.n, chunks.length - rkc21.length);
    assert.deepEqual(excluded.map((e) => [e.contentId, e.aiEligibility, e.chunkCount]), [["RKC-000021", "Not Eligible", 4]]);
    assert.ok(index.indexed.every((i) => i.chunk.documentId !== "RKC-000021"));
  });

  test("RKC-000012 stays, restricted, and every unregistered file is reported", () => {
    assert.deepEqual(report.restricted.map((r) => r.contentId), ["RKC-000012"]);
    assert.ok(index.indexed.some((i) => i.chunk.documentId === "RKC-000012" && i.chunk.governance?.restriction));
    assert.ok(report.unregistered.length >= 1);
    assert.ok(report.unregistered.every((u) => !u.documentId.startsWith("RKC-")));
  });

  test("a restricted source's caveat reaches the prompt", () => {
    const hit = index.indexed.find((i) => i.chunk.documentId === "RKC-000012")!;
    const prompt = buildPrompt("Tell me about the pricing narrative.", [{ chunk: hit.chunk, score: 1 }] as never, [], undefined);
    assert.ok(prompt.includes("Registry restriction:"));
    assert.ok(prompt.includes("[Registry restriction notice]"));
  });

  test("hard pass/fail: RKC-000021 is not retrievable under any query, including ones that name it", () => {
    const queries = [
      "How can I present Wellhub to a prospect? Write a 1-min elevator pitch.",
      "Write me an elevator pitch.",
      "Do we have an elevator pitch?",
      'RKO 2026 "What is Wellhub" Elevator Pitch Submission',
      "elevator pitch scorecard",
      "#1 superpower engagement didn't have a gym corporate wellbeing solution",
      "Submit your elevator pitch for the RKO 2026 challenge",
      ...rkc21.map((c) => c.text.slice(0, 200)),
      ...rkc21.map((c) => c.heading ?? ""),
    ];
    for (const q of queries) {
      for (const r of search(index, q, 50)) assert.notEqual(r.chunk.documentId, "RKC-000021", `retrieved for: ${q.slice(0, 60)}`);
    }
  });

  test("none of its text can reach a prompt or a citation", () => {
    const vocab = createRegionVocabulary(null);
    const q = "How can I present Wellhub to a prospect? Write a 1-min elevator pitch.";
    const ranked = search(index, q, 15);
    const decision = applyApplicability(detectTaskRegions(vocab, [q]), ranked, 5);
    const prompt = buildPrompt(q, decision.eligible, [], decision).replace(/\s+/g, " ");
    const citations = decision.eligible.map((r) => formatCitation(r.chunk)).join("\n");
    for (const c of rkc21) {
      const sample = c.text.replace(/\s+/g, " ").trim().slice(0, 80);
      assert.ok(!prompt.includes(sample), `prompt contains excluded text: ${sample}`);
    }
    assert.ok(!citations.includes("RKC-000021"));
    assert.ok(!/What is Wellhub"? Elevator Pitch Submission/.test(citations));
  });
});

describe("access-level policy (V1: Hubi cannot verify who is asking)", () => {
  const entry = (contentId: string, accessLevel: string, extra: Partial<RegistrySnapshot["entries"][number]> = {}): RegistrySnapshot["entries"][number] => ({
    contentId,
    aiEligibility: "Eligible",
    contentStatus: "Active",
    region: "Global",
    risks: [],
    contentType: "Training",
    collection: "Sales Methodology",
    accessLevel,
    sourceModified: "27/02/2026",
    ...extra,
  });
  const registry: RegistrySnapshot = {
    ...REGISTRY,
    entries: [
      entry("RKC-000001", "Revenue – All"),
      entry("RKC-000002", "Revenue – Specific Function"),
      entry("RKC-000003", "Revenue – Leaders Only"),
      entry("RKC-000004", ""),
      entry("RKC-000005", "Restricted – Confidential"),
      entry("RKC-000006", "revenue - all"),
    ],
  };
  const chunks = ["RKC-000001", "RKC-000002", "RKC-000003", "RKC-000004", "RKC-000005", "RKC-000006"].map((id) => chunk(id, id));
  const result = applyGovernance(chunks, { registry });

  test("the pilot policy serves Revenue – All and Revenue – Specific Function, and nothing else", () => {
    assert.deepEqual(ids(result.chunks), ["RKC-000001", "RKC-000002", "RKC-000006"]);
  });

  test("Leaders Only, restricted and blank levels are excluded with the access-level reason", () => {
    const reasons = Object.fromEntries(result.excluded.map((e) => [e.contentId, e.reason]));
    assert.match(reasons["RKC-000003"], /Revenue – Leaders Only.*not served in V1/);
    assert.match(reasons["RKC-000004"], /blank/);
    assert.match(reasons["RKC-000005"], /Restricted – Confidential/);
    assert.ok(describeGovernance(result.report).some((l) => l.includes("excluded RKC-000003")));
  });

  test("levels compare ignoring case, spacing and the kind of dash", () => {
    assert.equal(normalizeAccessLevel("Revenue – All"), normalizeAccessLevel("revenue - all"));
    assert.equal(normalizeAccessLevel("Revenue — All"), normalizeAccessLevel("Revenue  –  All"));
  });

  test("an excluded document leaves no chunk behind, and an eligibility exclusion still wins over the access rule", () => {
    assert.ok(!ids(result.chunks).includes("RKC-000003"));
    const mixed = applyGovernance([chunk("RKC-000007", "x")], { registry: { ...registry, entries: [entry("RKC-000007", "Revenue – All", { aiEligibility: "Not Eligible" })] } });
    assert.match(mixed.excluded[0].reason, /AI Eligibility: Not Eligible/);
  });

  test("with no served-level list there is no access rule, so the policy can be widened or lifted without code", () => {
    const open = applyGovernance(chunks, { registry, policy: { ...PILOT_GOVERNANCE_POLICY, servedAccessLevels: undefined } });
    assert.equal(open.chunks.length, 6);
    const wider = applyGovernance(chunks, { registry, policy: { ...PILOT_GOVERNANCE_POLICY, servedAccessLevels: ["Revenue – All", "Revenue – Specific Function", "Revenue – Leaders Only"] } });
    assert.ok(ids(wider.chunks).includes("RKC-000003"));
  });

  test("served chunks carry the registry's source facts for labelling and source selection", () => {
    const g = result.chunks.find((c) => c.id === "RKC-000002")?.governance;
    assert.equal(g?.contentType, "Training");
    assert.equal(g?.collection, "Sales Methodology");
    assert.equal(g?.accessLevel, "Revenue – Specific Function");
    assert.equal(g?.sourceModified, "27/02/2026");
  });

  test("the compiled snapshot carries the four columns, and exactly RKC-000001 and RKC-000017 are Leaders Only", () => {
    const leaders = REGISTRY_SNAPSHOT.entries.filter((e) => normalizeAccessLevel(e.accessLevel) === normalizeAccessLevel("Revenue – Leaders Only")).map((e) => e.contentId);
    assert.deepEqual(leaders, ["RKC-000001", "RKC-000017"]);
    const e41 = REGISTRY_SNAPSHOT.entries.find((e) => e.contentId === "RKC-000041");
    assert.equal(e41?.contentType, "Newsletter");
    assert.equal(e41?.collection, "Trending This Week");
    assert.equal(e41?.sourceModified, "14/7/26");
    assert.ok(REGISTRY_SNAPSHOT.entries.every((e) => typeof e.contentType === "string" && typeof e.accessLevel === "string"));
  });

  test("the export parser reads the four columns by their sheet headings", () => {
    const csv = [
      "Content ID,Content Type,Collection,Access Level,Source Platform Modified Date,Content Status,AI Eligibility",
      "RKC-000001,Newsletter,Trending This Week,Revenue – All,14/7/26,Active,Eligible",
    ].join(String.fromCharCode(10));
    const [e] = parseRegistryCsv(csv).entries;
    assert.deepEqual([e.contentType, e.collection, e.accessLevel, e.sourceModified], ["Newsletter", "Trending This Week", "Revenue – All", "14/7/26"]);
  });
});
