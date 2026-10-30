import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { searchContext } from "../lib/runtime/sessionState.ts";
import { detectLanguage, planExpansion } from "../lib/retrieval/queryExpansion.ts";

describe("search context", () => {
  it("keeps the question a short reply answers, so its words and language stay in the search", () => {
    const c = searchContext(["What are the steps of the client onboarding process?", "Mexico"]);
    assert.equal(c.query, "What are the steps of the client onboarding process? Mexico");
    assert.equal(c.anchor, "What are the steps of the client onboarding process?");
    assert.equal(c.reset, false);
    assert.equal(searchContext(["Qual contrato devo usar?", "Brasil"]).anchor, "Qual contrato devo usar?");
  });
  it("keeps a statement of context in the topic, however long", () => {
    const c = searchContext(["How can I present Wellhub to a prospect? Write a 1-min elevator pitch.", "A company from the financial industry, enterprise size."]);
    assert.equal(c.reset, false);
    assert.match(c.query, /elevator pitch/);
  });
  it("starts a new topic for a new question that shares no content word with the topic", () => {
    const c = searchContext(["What are the steps of the client onboarding process?", "Mexico", "How do I connect Salesforce to Gmail?"]);
    assert.equal(c.query, "How do I connect Salesforce to Gmail?");
    assert.equal(c.anchor, "How do I connect Salesforce to Gmail?");
    assert.equal(c.reset, true);
  });
  it("keeps a follow-up that shares a word with the topic", () => {
    const c = searchContext(["What are the steps of the client onboarding process?", "US", "And what about onboarding for Tier 3?"]);
    assert.equal(c.reset, false);
    assert.match(c.query, /^What are the steps/);
  });
  it("starts a new topic only at the point of the change and keeps what follows it", () => {
    const c = searchContext(["Qual contrato devo usar?", "Brasil", "What is the Wellhubverse?", "Europe"]);
    assert.equal(c.query, "What is the Wellhubverse? Europe");
  });
  it("is the identity for a single message", () => {
    const c = searchContext(["Write me an elevator pitch."]);
    assert.deepEqual(c, { query: "Write me an elevator pitch.", anchor: "Write me an elevator pitch.", reset: false, start: 0 });
    assert.deepEqual(searchContext([]), { query: "", anchor: "", reset: false, start: 0 });
  });
  it("lets the cross-language check read the question and not the one-word reply", () => {
    assert.equal(planExpansion("Brasil", 5).reason, "too-short");
    assert.equal(detectLanguage("Qual contrato devo usar?"), "pt");
    assert.equal(planExpansion(searchContext(["Qual contrato devo usar?", "Brasil"]).anchor, 5).expand, true);
  });
});

describe("region pass uses the cross-language search", () => {
  it("surfaces the overview of a regional document written in another language", async () => {
    const { buildIndex } = await import("../lib/retrieval/index.ts");
    const { retrieveApplicable } = await import("../lib/runtime/retrieveApplicable.ts");
    const mk = (id: string, heading: string, text: string, regional: boolean) => ({
      id: `${id}::s0`, documentId: id, documentTitle: id, heading, text, citationUrl: null, citationUrlType: null as null,
      regions: regional ? ["SS Latam"] : ["Global"], regionScope: (regional ? "regional" : "global") as "regional" | "global", regionRaw: regional ? "SS Latam" : "Global",
    });
    const decoys = Array.from({ length: 6 }, (_, i) => mk(`en${i}`, "Client onboarding process steps", "client onboarding process steps overview of the process steps for each client", false));
    const index = buildIndex([...decoys, mk("ssl", "Pasos del proceso", "pasos del proceso de incorporacion del cliente etapas reunion de implementacion", true), mk("ssl-weak", "Objetivos", "client onboarding objetivos", true)]);
    const msgs = ["What are the steps of the client onboarding process?", "Mexico"];
    const without = retrieveApplicable(index, msgs.join(" "), msgs);
    const withTerms = retrieveApplicable(index, msgs.join(" "), msgs, { expansion: { terms: "pasos proceso incorporacion cliente etapas reunion implementacion", reason: "weak-lexical-match" } });
    assert.ok(!without.decision.eligible.some((r) => r.chunk.documentId === "ssl" ));
    assert.ok(withTerms.decision.eligible.some((r) => r.chunk.documentId === "ssl"));
  });
});
