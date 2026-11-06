import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeMarkdown } from "../lib/ingestion/normalize.ts";
import { OUTDATED_CAVEAT, parseRegistryCsv, restrictionCaveat, usableSourceUrl } from "../lib/governance/registry.ts";
import { applyGovernance } from "../lib/governance/governance.ts";
import { downloadSupportedObjects, type GcsFileLike } from "../lib/ingestion/contentSource.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import type { RegistrySnapshot } from "../lib/governance/registry.ts";

describe("normalizeMarkdown", () => {
  const md = ["# Payroll Self-Service — Product Summary", "", "> Product Area: W4C", "", "---", "", "## What is the product?", "A payroll section.", "", "| Feature | Source |", "|---|---|", "| Typo | Comm doc |"].join("\n");
  test("the first # heading is the title and ## headings are sections", () => {
    const doc = normalizeMarkdown(md, "x.md", "x");
    assert.equal(doc.title, "Payroll Self-Service — Product Summary");
    assert.deepEqual(doc.sections.map((s) => s.heading), [null, "What is the product?"]);
    assert.match(doc.sections[1].text, /A payroll section\./);
  });
  test("rules and table separator rows are dropped, blockquote metadata and table rows are kept", () => {
    const doc = normalizeMarkdown(md, "x.md", "x");
    const all = doc.sections.map((s) => s.text).join("\n");
    assert.ok(!/^---$/m.test(all) && !/\|---\|/.test(all));
    assert.match(all, /Product Area: W4C/);
    assert.match(all, /\| Typo \| Comm doc \|/);
  });
  test("an empty file warns instead of producing sections", () => {
    const doc = normalizeMarkdown("", "x.md", "x");
    assert.equal(doc.sections.length, 0);
    assert.ok(doc.extractionWarnings.length > 0);
  });
});

describe("registry caveat and source URL", () => {
  test("a restricted document flagged outdated with no note gets the standard caveat", () => {
    assert.equal(restrictionCaveat("Eligible with Restrictions", ["Outdated Content"], ""), OUTDATED_CAVEAT);
  });
  test("the registry note wins over the standard caveat", () => {
    assert.equal(restrictionCaveat("Eligible with Restrictions", ["Outdated Content"], "Relevant content that should be updated."), "Relevant content that should be updated.");
  });
  test("an unrestricted document, or one without an outdated flag, carries no caveat", () => {
    assert.equal(restrictionCaveat("Eligible", ["Outdated Content"], ""), undefined);
    assert.equal(restrictionCaveat("Eligible with Restrictions", ["Other"], ""), undefined);
  });
  test("only openable links are kept as citations", () => {
    assert.equal(usableSourceUrl("https://docs.google.com/document/d/abc/edit "), "https://docs.google.com/document/d/abc/edit");
    assert.equal(usableSourceUrl("https://wellhub-revacademy.app.workramp.com/admin/guides/019be16f"), undefined);
    assert.equal(usableSourceUrl("https://www.google.com/url?sa=t&url=https://drive.google.com/x"), undefined);
    assert.equal(usableSourceUrl(""), undefined);
    assert.equal(usableSourceUrl("not a url"), undefined);
  });
  test("the CSV reader carries the caveat and the URL into the entry", () => {
    const csv = ["Content ID,Region / Country,Content Status,AI Eligibility,Issues / Risks,Notes,Original Source URL", "RKC-000080,Global,Active,Eligible with Restrictions,Outdated Content,,https://docs.google.com/document/d/abc/edit"].join("\n");
    const { entries } = parseRegistryCsv(csv);
    assert.equal(entries[0].restriction, OUTDATED_CAVEAT);
    assert.equal(entries[0].sourceUrl, "https://docs.google.com/document/d/abc/edit");
  });
});

describe("governance fills what the document does not say", () => {
  const snapshot: RegistrySnapshot = {
    source: "t",
    sourceRevision: "t",
    syncedAt: "2026-11-06",
    entries: [
      { contentId: "RKC-000097", aiEligibility: "Eligible", contentStatus: "Active", region: "Germany", risks: [], contentType: "Deck", collection: "", accessLevel: "Revenue – All", sourceModified: "", sourceUrl: "https://docs.google.com/presentation/d/de/edit" },
      { contentId: "RKC-000010", aiEligibility: "Eligible", contentStatus: "Active", region: "Germany", risks: [], contentType: "Training", collection: "", accessLevel: "Revenue – All", sourceModified: "", sourceUrl: "https://docs.google.com/document/d/other/edit" },
    ],
  };
  const chunk = (documentId: string, extra: Partial<Chunk> = {}): Chunk => ({ id: `${documentId}::s0`, documentId, documentTitle: documentId, heading: null, text: "t", citationUrl: null, citationUrlType: null, ...extra });

  test("a chunk with no link and no region takes the registry's", () => {
    const out = applyGovernance([chunk("RKC-000097")], { registry: snapshot }).chunks[0];
    assert.equal(out.citationUrl, "https://docs.google.com/presentation/d/de/edit");
    assert.equal(out.citationUrlType, "registryUrl");
    assert.equal(out.regionScope, "regional");
    assert.equal(out.regionRaw, "Germany");
    assert.ok((out.regions ?? []).length > 0 && !out.regions!.includes("Global"));
  });
  test("the document's own link and region are never overwritten", () => {
    const out = applyGovernance(
      [chunk("RKC-000010", { citationUrl: "https://own.example/x", citationUrlType: "sourceUrl", regionRaw: "Global", regionScope: "global", regions: ["Global"] })],
      { registry: snapshot }
    ).chunks[0];
    assert.equal(out.citationUrl, "https://own.example/x");
    assert.equal(out.regionScope, "global");
  });
});

describe("downloadSupportedObjects with onFile", () => {
  test("hands each file over and removes it before the next, so only one is on disk at a time", async () => {
    const files: GcsFileLike[] = ["a.docx", "b.pptx", "c.mp4"].map((name) => ({ name: `repo/${name}`, metadata: { size: 5 }, createReadStream: () => Readable.from([Buffer.from("12345")]) }));
    const dest = mkdtempSync(path.join(os.tmpdir(), "hubi-test-"));
    const seen: { relative: string; existedThen: boolean }[] = [];
    const paths: string[] = [];
    await downloadSupportedObjects({ getFiles: async () => [files] }, "b", "repo", dest, () => {}, (filePath, relative) => {
      seen.push({ relative, existedThen: existsSync(filePath) });
      paths.push(filePath);
    });
    assert.deepEqual(seen, [{ relative: "a.docx", existedThen: true }, { relative: "b.pptx", existedThen: true }]);
    assert.ok(paths.every((p) => !existsSync(p)));
  });
});

describe("country-level sources", () => {
  const snapshot: RegistrySnapshot = {
    source: "t", sourceRevision: "t", syncedAt: "2026-11-06",
    entries: [{ contentId: "RKC-000097", aiEligibility: "Eligible", contentStatus: "Active", region: "Germany", risks: [], contentType: "Deck", collection: "", accessLevel: "Revenue – All", sourceModified: "" }],
  };
  test("governance records the country a registry region names, beside the wider operating region", () => {
    const c: Chunk = { id: "a", documentId: "RKC-000097", documentTitle: "t", heading: null, text: "t", citationUrl: null, citationUrlType: null };
    const out = applyGovernance([c], { registry: snapshot }).chunks[0];
    assert.deepEqual(out.countries, ["Germany"]);
    assert.ok(out.regions && !out.regions.includes("Germany"));
  });
  test("Netherland is read as the Netherlands, in Europe", () => {
    const c: Chunk = { id: "a", documentId: "RKC-000097", documentTitle: "t", heading: null, text: "t", citationUrl: null, citationUrlType: null };
    const nl: RegistrySnapshot = { ...snapshot, entries: [{ ...snapshot.entries[0], region: "Netherland" }] };
    const out = applyGovernance([c], { registry: nl }).chunks[0];
    assert.equal(out.regionScope, "regional");
    assert.deepEqual(out.regions, ["Europe"]);
  });
});

describe("prepared corpus", () => {
  test("is used only when the source objects are exactly the ones it was built from", async () => {
    const { sameObjects } = await import("../lib/ingestion/corpusSnapshot.ts");
    assert.equal(sameObjects(["a|1|9", "b|2|8"], ["a|1|9", "b|2|8"]), true);
    assert.equal(sameObjects(["a|1|9"], ["a|1|10"]), false, "a replaced file has a new generation");
    assert.equal(sameObjects(["a|1|9"], ["a|1|9", "b|2|8"]), false, "an added file");
    assert.equal(sameObjects(["a|1|9", "b|2|8"], ["a|1|9"]), false, "a removed file");
  });
});
