import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, planExpansion } from "../lib/retrieval/queryExpansion.ts";
import { inferRegionFromLanguage } from "../lib/applicability/languageRegion.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { buildIndex } from "../lib/retrieval/index.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";

describe("detecting German, French, Italian and Dutch", () => {
  test("recognises each language", () => {
    assert.equal(detectLanguage("Wie läuft der Onboarding-Prozess für einen neuen Kunden ab?"), "de");
    assert.equal(detectLanguage("Quel est le processus pour une nouvelle entreprise cliente dans le contrat?"), "fr");
    assert.equal(detectLanguage("Quali sono gli step del processo nella fase di onboarding?"), "it");
    assert.equal(detectLanguage("Hoe werkt het proces voor een klant met een contract?"), "nl");
  });
  test("English, Spanish and Portuguese are unchanged", () => {
    assert.equal(detectLanguage("What is the onboarding process for a new client?"), "en");
    assert.equal(detectLanguage("¿Qué reuniones de onboarding tengo que hacer?"), "es");
    assert.equal(detectLanguage("Qual contrato devo usar?"), "pt");
  });
  test("a non-English question is expanded into English search terms", () => {
    assert.equal(planExpansion("Wie läuft der Onboarding-Prozess für einen neuen Kunden ab?", 30).expand, true);
  });
});

describe("region from language (Product decision 2026-11-04)", () => {
  test("Portuguese -> Brazil; German, French, Italian, Dutch -> Europe", () => {
    assert.equal(inferRegionFromLanguage(["Qual contrato devo usar para um cliente novo?"]), "Brazil");
    assert.equal(inferRegionFromLanguage(["Wie läuft der Onboarding-Prozess für einen neuen Kunden ab?"]), "Europe");
    assert.equal(inferRegionFromLanguage(["Quel est le processus pour une nouvelle entreprise cliente dans le contrat?"]), "Europe");
    assert.equal(inferRegionFromLanguage(["Quali sono gli step del processo nella fase di onboarding?"]), "Europe");
    assert.equal(inferRegionFromLanguage(["Hoe werkt het proces voor een klant met een contract?"]), "Europe");
  });
  test("Spanish and English never imply a region: the user is asked", () => {
    assert.equal(inferRegionFromLanguage(["¿Qué reuniones de onboarding tengo que hacer?"]), undefined);
    assert.equal(inferRegionFromLanguage(["What is the onboarding process for a new client?"]), undefined);
    assert.equal(inferRegionFromLanguage(["reuniones de cliente"]), undefined); // Spanish or Portuguese: cannot tell
  });
  test("a short reply does not decide the language: the earlier question does", () => {
    assert.equal(inferRegionFromLanguage(["Qual contrato devo usar para um cliente novo?", "Tier 1"]), "Brazil");
    assert.equal(inferRegionFromLanguage(["What is the onboarding process for a new client?", "Tier 1"]), undefined);
  });
});

function chunk(id: string, text: string, regions: string[], scope: "regional" | "global" = "regional"): Chunk {
  return { id, documentId: id, documentTitle: id, heading: null, text, citationUrl: null, citationUrlType: null, regions, regionScope: scope } as Chunk;
}

describe("the inferred region in retrieval", () => {
  const index = buildIndex([
    chunk("br", "contrato de venda direta onboarding processo cliente Brasil", ["Brazil"]),
    chunk("eu", "contract onboarding process client Europe steps", ["Europe"]),
  ]);
  test("a Portuguese question is treated as Brazil, and the source says so", () => {
    const r = retrieveApplicable(index, "contrato onboarding processo cliente", ["Qual contrato devo usar para o onboarding do cliente?"]);
    assert.equal(r.regionSource, "language");
    assert.deepEqual(r.decision.taskRegions, ["Brazil"]);
  });
  test("a region the user names beats the language", () => {
    const r = retrieveApplicable(index, "contrato onboarding processo cliente", ["Qual contrato devo usar para o onboarding do cliente?", "Europe"]);
    assert.equal(r.regionSource, "message");
    assert.deepEqual(r.decision.taskRegions, ["Europe"]);
  });
  test("HUBI_LANGUAGE_REGION=0 switches the inference off", () => {
    process.env.HUBI_LANGUAGE_REGION = "0";
    try {
      const r = retrieveApplicable(index, "contrato onboarding processo cliente", ["Qual contrato devo usar para o onboarding do cliente?"]);
      assert.equal(r.regionSource, "none");
    } finally {
      delete process.env.HUBI_LANGUAGE_REGION;
    }
  });
});
