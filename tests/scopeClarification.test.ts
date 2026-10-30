import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import type { ApplicabilityDecision } from "../lib/applicability/evaluate.ts";
import { buildScopeJudgePrompt, findScopeCandidates, judgeScope, parseScopeJudgement, type ScopeGroup } from "../lib/applicability/scopeClarification.ts";
import { MAX_CLARIFICATIONS_PER_TOPIC, applyScopeGate } from "../lib/runtime/scopeGate.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";

const NL = String.fromCharCode(10);

function hit(documentId: string, audience: string[] | undefined, score: number, text = "contract rules"): { chunk: Chunk; score: number } {
  return { score, chunk: { id: `${documentId}::s0`, documentId, documentTitle: `Title ${documentId}`, heading: "H", text, citationUrl: null, citationUrlType: null, audience } };
}

const PARTNER_TEXT = "For partner deals the contract must be signed and list the number of eligible employees and the contract term.";
const DIRECT_TEXT = "For direct sales use the SMB order form in Salesforce and upload the standard terms without changes.";
const groups: ScopeGroup[] = [
  { audience: ["Channel partners"], documents: [{ documentId: "p", title: "Partners", heading: "Rule", excerpt: PARTNER_TEXT }] },
  { audience: ["Sales ENT"], documents: [{ documentId: "d", title: "Direct", heading: "Rule", excerpt: DIRECT_TEXT }] },
];

/** A judge reply in the requested format. `evidence` null means NONE for that situation. */
function reply(evidence: (string | null)[], different: string, said: string, question: string): string {
  return [...evidence.map((e, i) => `SITUATION_${i + 1}_EVIDENCE: ${e ?? "NONE"}`), `DIFFERENT_REQUIREMENTS: ${different}`, `USER_ALREADY_SAID: ${said}`, `QUESTION: ${question}`].join(NL);
}
const GOOD = reply(["the contract must be signed and list the number of eligible employees", "use the SMB order form in Salesforce and upload the standard terms"], "YES", "NO", "Is this for direct sales or the partner channel?");

describe("scope candidates", () => {
  it("finds two documents that match about as well and are written for audiences sharing no label", () => {
    const g = findScopeCandidates([hit("partners", ["Channel partners"], 13), hit("direct", ["Sales ENT"], 9)], 13);
    assert.deepEqual(g?.map((x) => x.audience), [["Channel partners"], ["Sales ENT"]]);
  });
  it("ignores a competing document that matches the question much less well", () => {
    assert.equal(findScopeCandidates([hit("partners", ["Channel partners"], 13), hit("direct", ["Sales ENT"], 6)], 13), null);
  });
  it("needs disjoint labels: overlapping audiences, everyone-labels and unlabelled documents are not situations", () => {
    assert.equal(findScopeCandidates([hit("a", ["Sales", "CS"], 10), hit("b", ["CS", "WE"], 10)], 10), null);
    assert.equal(findScopeCandidates([hit("a", ["Sales"], 10), hit("b", ["Revenue"], 10)], 10), null);
    assert.equal(findScopeCandidates([hit("a", ["Sales"], 10), hit("b", undefined, 10)], 10), null);
    assert.equal(findScopeCandidates([hit("a", ["Sales"], 10), hit("a", ["Sales"], 9)], 10), null);
  });
  it("keeps the best excerpt per document and at most two documents per situation", () => {
    const g = findScopeCandidates([hit("p1", ["Partners"], 10, "x"), hit("p1", ["Partners"], 12, "best"), hit("p2", ["Partners"], 9), hit("p3", ["Partners"], 8), hit("d", ["Direct"], 9)], 12);
    const partners = g?.find((x) => x.audience[0] === "Partners");
    assert.equal(partners?.documents.length, 2);
    assert.equal(partners?.documents[0].excerpt, "best");
  });
});

describe("scope judge", () => {
  it("asks when each situation's answer is quoted from its own material and the requirements differ", () => {
    assert.equal(parseScopeJudgement(GOOD, groups), "Is this for direct sales or the partner channel?");
  });
  it("does not ask when a situation has no evidence: material about another topic has nothing to quote", () => {
    assert.equal(parseScopeJudgement(reply(["the contract must be signed and list the number of eligible employees", null], "YES", "NO", "Which one?"), groups), null);
    assert.equal(parseScopeJudgement(reply([null, null], "YES", "NO", "Which one?"), groups), null);
  });
  it("ignores situations that have no evidence as long as two others do, and asks only about those", () => {
    const three: ScopeGroup[] = [...groups, { audience: ["Sales"], documents: [{ documentId: "c", title: "Competition", heading: "H", excerpt: "Competitors must never agree on prices." }] }];
    const r = [reply(["the contract must be signed and list the number of eligible employees", "use the SMB order form in Salesforce and upload the standard terms", null], "YES", "NO", "Direct or partner?")].join(NL);
    assert.equal(parseScopeJudgement(r, three), "Direct or partner?");
  });
  it("does not accept a quote that is not in that situation's excerpt, a too-short quote, or one taken from the other situation", () => {
    assert.equal(parseScopeJudgement(reply(["the contract must be notarised before launch", "use the SMB order form in Salesforce"], "YES", "NO", "Which one?"), groups), null);
    assert.equal(parseScopeJudgement(reply(["must be signed", "use the SMB order form in Salesforce"], "YES", "NO", "Which one?"), groups), null);
    assert.equal(parseScopeJudgement(reply(["use the SMB order form in Salesforce", "use the SMB order form in Salesforce"], "YES", "NO", "Which one?"), groups), null);
  });
  it("tolerates quote marks, case, spacing and a trailing ellipsis in the quote", () => {
    const r = reply(['"The contract must be signed   and list the number of eligible employees..."', "Use the SMB order form in Salesforce"], "YES", "NO", "Direct or partner?");
    assert.equal(parseScopeJudgement(r, groups), "Direct or partner?");
  });
  it("does not ask when the requirements do not differ, when the user already said, or when the question is not a question", () => {
    assert.equal(parseScopeJudgement(GOOD.replace("DIFFERENT_REQUIREMENTS: YES", "DIFFERENT_REQUIREMENTS: NO"), groups), null);
    assert.equal(parseScopeJudgement(GOOD.replace("USER_ALREADY_SAID: NO", "USER_ALREADY_SAID: YES"), groups), null);
    assert.equal(parseScopeJudgement(GOOD.replace(/QUESTION: .*$/, "QUESTION: NONE"), groups), null);
    assert.equal(parseScopeJudgement(GOOD.replace(/QUESTION: .*$/, "QUESTION: It differs by channel."), groups), null);
    assert.equal(parseScopeJudgement("NONE", groups), null);
    assert.equal(parseScopeJudgement("", groups), null);
  });
  it("shows the model the question, what the user said and each situation, and asks for a quote per situation", () => {
    const p = buildScopeJudgePrompt("Which contract?", ["Which contract?", "Brazil"], groups);
    assert.ok(p.includes('"Which contract?" / "Brazil"'));
    assert.match(p, /material written for Channel partners/);
    assert.match(p, /SITUATION_1_EVIDENCE/);
    assert.match(p, /SITUATION_2_EVIDENCE/);
    assert.match(p, /word for word/);
    assert.match(p, /USER_ALREADY_SAID/);
  });
  it("never throws: a failed call or a thrown error means no question", async () => {
    assert.equal((await judgeScope(async () => ({ ok: false, text: "", error: "429" }), "q", ["q"], groups)).question, null);
    assert.equal((await judgeScope(async () => Promise.reject(new Error("boom")), "q", ["q"], groups)).question, null);
  });
});

describe("scope gate", () => {
  const base: ApplicabilityDecision = {
    taskRegions: ["Brazil"], taskCountries: [], mode: "none", eligible: [hit("p", ["Channel partners"], 10)], eligibleStatuses: ["match"],
    withheldRegions: [], mismatchRegions: [], withheldCount: 0, mismatchCount: 0, unspecifiedUsed: 0,
  };

  it("does nothing, and makes no call, when there are no candidate situations", async () => {
    let calls = 0;
    const out = await applyScopeGate(async () => (calls++, { ok: true, text: GOOD }), base, null, "q", ["q"]);
    assert.equal(calls, 0);
    assert.equal(out.decision, base);
  });
  it("gates the turn with the judge's question and sends no source content", async () => {
    const out = await applyScopeGate(async () => ({ ok: true, text: GOOD }), base, groups, "Which contract?", ["Which contract?", "Brazil"]);
    assert.equal(out.decision.mode, "must-clarify");
    assert.equal(out.decision.clarifyReason, "scope-conflict");
    assert.deepEqual(out.decision.eligible, []);
    assert.equal(out.judged?.asked, true);
    const prompt = buildPrompt("Which contract?", out.decision.eligible, [], out.decision);
    assert.match(prompt, /\[Clarification gate -- mandatory\]/);
    assert.match(prompt, /Is this for direct sales or the partner channel\?/);
    assert.match(prompt, /CLARIFYING_QUESTION/);
  });
  it("leaves the answer alone when the judge finds no shared question or fails, and never re-gates a gated turn", async () => {
    const none = await applyScopeGate(async () => ({ ok: true, text: reply([null, null], "NO", "NO", "NONE") }), base, groups, "q", ["q"]);
    assert.equal(none.decision, base);
    assert.equal(none.judged?.asked, false);
    const failed = await applyScopeGate(async () => ({ ok: false, text: "", error: "x" }), base, groups, "q", ["q"]);
    assert.equal(failed.decision, base);
    let calls = 0;
    await applyScopeGate(async () => (calls++, { ok: true, text: GOOD }), { ...base, mode: "must-clarify" as const }, groups, "q", ["q"]);
    assert.equal(calls, 0);
  });
  it("stops asking once the topic has cost two questions", async () => {
    let calls = 0;
    const engine = async () => (calls++, { ok: true, text: GOOD });
    assert.equal(MAX_CLARIFICATIONS_PER_TOPIC, 2);
    assert.equal((await applyScopeGate(engine, base, groups, "q", ["q"], 1)).decision.mode, "must-clarify");
    assert.equal((await applyScopeGate(engine, base, groups, "q", ["q"], 2)).decision.mode, "none");
    assert.equal(calls, 1);
  });
  it("counts the clarifying questions asked in the current topic only", async () => {
    const { clarificationsInTopic } = await import("../lib/runtime/sessionState.ts");
    const u = (content: string) => ({ role: "user" as const, content });
    const a = (content: string) => ({ role: "assistant" as const, content });
    assert.equal(clarificationsInTopic([u("Qual contrato devo usar?"), a("Para qual região?"), u("Brasil"), a("Direta ou parceiros?"), u("Direta")]), 2);
    assert.equal(clarificationsInTopic([u("What are the steps of the onboarding process?"), a("Which region?"), u("US"), a("Here are the steps."), u("How do I connect Salesforce to Gmail?")]), 0);
    assert.equal(clarificationsInTopic([u("What is PPS?")]), 0);
  });
});
