import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRevisionPrompt, verifyClaims } from "../lib/runtime/claimVerifier.ts";
import { CLAIM_VERIFIER_PILOT_DEFAULT, generateWithVerification, shouldVerify, verificationEnabled } from "../lib/runtime/verifiedGeneration.ts";
import type { ReasoningEngine, ReasoningResult } from "../lib/runtime/reasoningEngine.ts";

// Offline: the verify-and-revise pass is exercised with a fake engine, so what
// is tested is the control flow and the checks, never model behavior.

const SOURCES = ["Clients see up to 42% enrollment. 60% of subscribers had no gym membership before. Platform for fitness and nutrition."];

const BA = "[[HUBI:MODE:BUSINESS_ASSISTANCE]]\n";
const END = "\n[[HUBI:GROUNDED_ANSWER]]";
const CLEAN = `${BA}Wellhub gives employees one platform for fitness and nutrition, and clients see up to 42% enrollment.${END}`;
const DIRTY = `${BA}Wellhub gives employees one platform, clients see up to 42% enrollment and a 75% boost, and it raises productivity and ROI.${END}`;
const FIXED = `${BA}Wellhub gives employees one platform, and clients see up to 42% enrollment.${END}`;

function result(text: string, durationMs = 1000, ok = true): ReasoningResult {
  return { ok, text, mode: "stream", durationMs, error: ok ? undefined : "boom" };
}

function fakeEngine(responses: ReasoningResult[]) {
  const calls: { prompt: string; system: string; streamed: boolean }[] = [];
  const engine: ReasoningEngine = async (prompt, system, opts) => {
    calls.push({ prompt, system, streamed: Boolean(opts?.onDelta) });
    const next = responses[calls.length - 1];
    if (!next) throw new Error("unexpected extra engine call");
    return next;
  };
  return { engine, calls };
}

const run = (engine: ReasoningEngine, verify = true) =>
  generateWithVerification({ engine, prompt: "ORIGINAL PROMPT", systemPrompt: "SYSTEM", retrievedTexts: SOURCES, verify, onDelta: () => {} });

describe("verifyClaims", () => {
  test("flags figures and value language that no retrieved chunk contains, and lists the phrases", () => {
    const v = verifyClaims("A 75% boost, and it raises productivity and ROI. Up to 42% enrollment.", SOURCES);
    assert.deepEqual(v.phrases.sort(), ["75%", "productivity", "roi"].sort());
    assert.equal(v.violations.length, 3);
  });

  test("passes text whose figures and value terms are all in the sources", () => {
    assert.deepEqual(verifyClaims("Clients see up to 42% enrollment on a fitness and nutrition platform.", SOURCES).violations, []);
  });

  test("is general: the same logic on an unrelated corpus", () => {
    const v = verifyClaims("The tool saves you money and closes 30% more deals.", ["The tool tracks open deals."]);
    assert.ok(v.phrases.includes("30%"));
    assert.ok(v.phrases.some((p) => /money/i.test(p)));
  });
});

describe("buildRevisionPrompt", () => {
  test("carries the original prompt, the flagged items, the draft, and the format reminder", () => {
    const verification = verifyClaims("A 75% boost.", SOURCES);
    const prompt = buildRevisionPrompt("ORIGINAL PROMPT", "A 75% boost.", verification);
    assert.ok(prompt.startsWith("ORIGINAL PROMPT"));
    assert.match(prompt, /\[Revision required -- claim check\]/);
    assert.match(prompt, /figure not in retrieved knowledge \("75%"\)/);
    assert.match(prompt, /Do not add new claims, figures or benefits/);
    assert.match(prompt, /planning-mode tag on the first line and the turn-kind tag on the last line/);
    assert.match(prompt, /<<<\nA 75% boost\.\n>>>/);
  });
});

describe("pilot setting", () => {
  test("the claim verifier is a pilot guardrail that is ON by default", () => {
    assert.equal(CLAIM_VERIFIER_PILOT_DEFAULT, true);
    assert.equal(verificationEnabled({}), true);
    assert.equal(verificationEnabled({ HUBI_VERIFY_CLAIMS: "" }), true);
  });

  test("HUBI_VERIFY_CLAIMS=0 turns it off and =1 forces it on", () => {
    assert.equal(verificationEnabled({ HUBI_VERIFY_CLAIMS: "0" }), false);
    assert.equal(verificationEnabled({ HUBI_VERIFY_CLAIMS: " 0 " }), false);
    assert.equal(verificationEnabled({ HUBI_VERIFY_CLAIMS: "1" }), true);
  });
});

describe("shouldVerify", () => {
  test("only predicted artifact requests are buffered and verified, and the off-switch wins", () => {
    assert.equal(shouldVerify("Write me a pitch.", undefined, {}), true);
    assert.equal(shouldVerify("Write me a pitch.", undefined, { HUBI_VERIFY_CLAIMS: "0" }), false);
    assert.equal(shouldVerify("What is the eligibility rule?", undefined, {}), false);
    assert.equal(shouldVerify("Do we have an elevator pitch?", undefined, {}), false);
    assert.equal(shouldVerify("A retail company.", "business-assistance", {}), true);
    assert.equal(shouldVerify("A retail company.", "knowledge-retrieval", {}), false);
  });
});

describe("generateWithVerification", () => {
  test("verification off: one streamed call, nothing buffered or checked", async () => {
    const { engine, calls } = fakeEngine([result(DIRTY)]);
    const out = await run(engine, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].streamed, true);
    assert.equal(out.response.text, DIRTY);
    assert.equal(out.verification.buffered, false);
    assert.equal(out.verification.checked, false);
  });

  test("verification on: the draft is buffered (not streamed)", async () => {
    const { engine, calls } = fakeEngine([result(CLEAN)]);
    await run(engine);
    assert.equal(calls[0].streamed, false);
  });

  test("a turn that is not business-assistance is never scanned or revised", async () => {
    const { engine, calls } = fakeEngine([result(DIRTY.replace("BUSINESS_ASSISTANCE", "KNOWLEDGE_SYNTHESIS"))]);
    const out = await run(engine);
    assert.equal(calls.length, 1);
    assert.equal(out.verification.checked, false);
    assert.equal(out.verification.revised, false);
  });

  test("a clean business-assistance draft costs no extra call", async () => {
    const { engine, calls } = fakeEngine([result(CLEAN)]);
    const out = await run(engine);
    assert.equal(calls.length, 1);
    assert.equal(out.verification.checked, true);
    assert.equal(out.verification.violationsBefore, 0);
    assert.equal(out.verification.revised, false);
    assert.equal(out.response.text, CLEAN);
  });

  test("a dirty draft triggers exactly one revision, which replaces it when it has fewer violations", async () => {
    const { engine, calls } = fakeEngine([result(DIRTY, 8000), result(FIXED, 6000)]);
    const out = await run(engine);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].system, "SYSTEM");
    assert.match(calls[1].prompt, /\[Revision required -- claim check\]/);
    assert.ok(calls[1].prompt.includes("a 75% boost"));
    assert.equal(out.response.text, FIXED);
    assert.equal(out.response.durationMs, 14000);
    assert.equal(out.verification.revised, true);
    assert.equal(out.verification.revisionAccepted, true);
    assert.equal(out.verification.violationsBefore, 3);
    assert.equal(out.verification.violationsAfter, 0);
    assert.ok(out.verification.extraMs >= 0);
  });

  test("the first draft is kept in the verification record only when a revision was attempted, so the log shows what changed", async () => {
    const revisedRun = await run(fakeEngine([result(DIRTY), result(FIXED)]).engine);
    assert.ok(revisedRun.verification.draft?.includes("75% boost"));
    assert.deepEqual(revisedRun.verification.phrases.sort(), ["75%", "productivity", "roi"].sort());
    const cleanRun = await run(fakeEngine([result(CLEAN)]).engine);
    assert.equal(cleanRun.verification.draft, undefined);
    const unbuffered = await run(fakeEngine([result(DIRTY)]).engine, false);
    assert.equal(unbuffered.verification.draft, undefined);
  });

  test("a revision that is no better is discarded and the original draft stands", async () => {
    const { engine, calls } = fakeEngine([result(DIRTY), result(DIRTY)]);
    const out = await run(engine);
    assert.equal(calls.length, 2);
    assert.equal(out.response.text, DIRTY);
    assert.equal(out.verification.revised, true);
    assert.equal(out.verification.revisionAccepted, false);
    assert.equal(out.verification.violationsAfter, out.verification.violationsBefore);
  });

  test("a revision that is truncated is discarded even if it has no violations", async () => {
    const { engine } = fakeEngine([result(DIRTY), result(`${BA}Hi.${END}`)]);
    const out = await run(engine);
    assert.equal(out.response.text, DIRTY);
    assert.equal(out.verification.revisionAccepted, false);
  });

  test("a failed revision call never loses the draft", async () => {
    const { engine } = fakeEngine([result(DIRTY), result("", 100, false)]);
    const out = await run(engine);
    assert.equal(out.response.text, DIRTY);
    assert.equal(out.verification.revised, true);
    assert.equal(out.verification.revisionAccepted, false);
  });

  test("a failed draft call is returned as is, with no revision attempt", async () => {
    const { engine, calls } = fakeEngine([result("", 100, false)]);
    const out = await run(engine);
    assert.equal(calls.length, 1);
    assert.equal(out.response.ok, false);
  });

  test("at most one revision is ever made", async () => {
    const { engine, calls } = fakeEngine([result(DIRTY), result(DIRTY), result(DIRTY)]);
    await run(engine);
    assert.equal(calls.length, 2);
  });
});

describe("verifyClaims: questions are not claims", () => {
  test("a discovery question that mentions a value term is not flagged, but the same words as a claim are", () => {
    const sources = ["Wellhub offers a platform for fitness."];
    assert.deepEqual(verifyClaims("How are you currently measuring the return on investment of your wellbeing programs?", sources).violations, []);
    assert.deepEqual(verifyClaims("\"What does retention look like for your team today?\"", sources).violations, []);
    assert.equal(verifyClaims("Wellhub improves retention and delivers a strong ROI.", sources).violations.length, 2);
  });

  test("figures are still checked inside questions", () => {
    assert.equal(verifyClaims("Would a 75% increase matter to you?", ["Nothing numeric here."]).violations.length, 1);
  });
});
