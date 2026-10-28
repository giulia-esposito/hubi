import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIMS_CLOSE,
  CLAIMS_OPEN,
  LEDGER_INSTRUCTION,
  extractLedger,
  quoteAppearsIn,
  stripClaimsBlock,
  verifyAttribution,
  type LedgerClaim,
} from "../lib/runtime/claimAttribution.ts";
import { extractResponseTags } from "../lib/runtime/turnKind.ts";
import { generateWithVerification, ledgerEnabled, ledgerEnforced, verifyAnswer } from "../lib/runtime/verifiedGeneration.ts";
import { buildPrompt } from "../lib/runtime/promptBuilder.ts";
import type { ReasoningEngine, ReasoningResult } from "../lib/runtime/reasoningEngine.ts";

// Offline: ledger parsing and the attribution checks are deterministic, and the
// generation flow runs on a fake engine. Nothing here depends on model behavior
// or on the content repository.

const block = (claims: unknown) => `${CLAIMS_OPEN}\n${JSON.stringify(claims)}\n${CLAIMS_CLOSE}`;
const BA = "[[HUBI:MODE:BUSINESS_ASSISTANCE]]\n";
const END = "\n[[HUBI:GROUNDED_ANSWER]]";

const SLIDE =
  "Companies with the program show higher retention than those without it.\n" +
  "Note: based on a survey of 1,200 enterprise employees; results up to 30% in the US.";
const PLAIN = "Members attend 3 times more often than non-members in the first month.";

describe("ledger extraction", () => {
  test("parses a well-formed ledger and removes it from the text", () => {
    const raw = `${BA}Pitch text.\n${block([{ claim: "A", source: 1, quote: "some quote here" }])}${END}`;
    const out = extractLedger(raw);
    assert.equal(out.status, "ok");
    assert.deepEqual(out.claims, [{ claim: "A", source: 1, quote: "some quote here" }]);
    assert.ok(!out.text.includes("HUBI:CLAIMS"));
    assert.ok(out.text.includes("Pitch text."));
  });

  test("a missing block is 'missing', not an error", () => {
    const out = extractLedger(`${BA}Pitch.${END}`);
    assert.equal(out.status, "missing");
    assert.equal(out.claims.length, 0);
  });

  test("an unparseable or non-array block is 'malformed' and still stripped", () => {
    const bad = extractLedger(`Pitch.\n${CLAIMS_OPEN}\n{not json\n${CLAIMS_CLOSE}`);
    assert.equal(bad.status, "malformed");
    assert.ok(!bad.text.includes("HUBI:CLAIMS"));
    assert.equal(extractLedger(`${CLAIMS_OPEN}{"a":1}${CLAIMS_CLOSE}`).status, "malformed");
  });

  test("accepts a fenced JSON body and a numeric string source; skips invalid items", () => {
    const raw = `${CLAIMS_OPEN}\n\`\`\`json\n[{"claim":"A","source":"2","quote":"q"},{"claim":"","source":1,"quote":"q"},null]\n\`\`\`\n${CLAIMS_CLOSE}`;
    const out = extractLedger(raw);
    assert.equal(out.status, "ok");
    assert.equal(out.claims.length, 1);
    assert.equal(out.claims[0].source, 2);
  });

  test("the ledger never reaches visible text or tag parsing", () => {
    const raw = `${BA}Hello.\n${block([{ claim: "A", source: 1, quote: "q" }])}${END}`;
    assert.ok(!stripClaimsBlock(raw).includes("[[HUBI:CLAIMS"));
    const tags = extractResponseTags(raw);
    assert.equal(tags.planningMode, "business-assistance");
    assert.ok(!tags.text.includes("CLAIMS"));
    assert.ok(!tags.text.includes('"quote"'));
  });
});

describe("quote matching", () => {
  test("is verbatim modulo case, quotes and whitespace", () => {
    assert.ok(quoteAppearsIn("members attend 3 times   MORE often", PLAIN));
    assert.ok(!quoteAppearsIn("members attend 5 times more often", PLAIN));
  });

  test("supports ellipsis fragments in order", () => {
    assert.ok(quoteAppearsIn("Members attend ... in the first month", PLAIN));
    assert.ok(!quoteAppearsIn("in the first month ... Members attend", PLAIN));
  });

  test("a too-short or empty quote never matches", () => {
    assert.ok(!quoteAppearsIn("", PLAIN));
    assert.ok(!quoteAppearsIn("3", PLAIN));
  });
});

describe("attribution checks", () => {
  const types = (artifact: string, claims: LedgerClaim[], sources: string[]) => verifyAttribution(artifact, claims, sources).map((v) => v.type);

  test("a faithful claim passes", () => {
    const claim = "Members attend 3 times more often than non-members in the first month.";
    assert.deepEqual(types(claim, [{ claim, source: 1, quote: PLAIN }], [PLAIN]), []);
  });

  test("a source number that does not exist is flagged", () => {
    assert.deepEqual(types("x", [{ claim: "x", source: 4, quote: PLAIN }], [PLAIN]), ["bad-source"]);
  });

  test("a quote not in the cited source is flagged", () => {
    assert.deepEqual(types("x", [{ claim: "x", source: 1, quote: "members attend far more often than anyone" }], [PLAIN]), ["quote-not-found"]);
  });

  test("a figure in the claim that is not in its quote is flagged", () => {
    const claim = "Members attend 5 times more often than non-members.";
    assert.ok(types(claim, [{ claim, source: 1, quote: PLAIN }], [PLAIN]).includes("figure-not-in-quote"));
  });

  test("a comparison turned into a cause is flagged", () => {
    const claim = "The program drives higher retention.";
    const found = types(claim, [{ claim, source: 1, quote: "Companies with the program show higher retention than those without it." }], [SLIDE]);
    assert.ok(found.includes("causal-strengthening"));
  });

  test("causal wording that the quote itself uses is allowed", () => {
    const quote = "The program improves attendance.";
    const claim = "The program improves attendance.";
    assert.deepEqual(types(claim, [{ claim, source: 1, quote }], [quote]), []);
  });

  test("a population and sample stated in the footnote must be kept", () => {
    const quote = "results up to 30%";
    const claim = "Results reach 30%.";
    const found = types(claim, [{ claim, source: 1, quote }], [SLIDE]);
    assert.ok(found.includes("dropped-qualifier"));
  });

  test("keeping the qualifiers in the claim clears the violation", () => {
    const quote = "results up to 30%";
    const claim = "In a survey of 1,200 enterprise employees, results were up to 30%, though not on average.";
    const msgs = verifyAttribution(claim, [{ claim, source: 1, quote }], [SLIDE]).filter((v) => v.type === "dropped-qualifier");
    assert.ok(!msgs.some((m) => /population|sample|hedge/.test(m.message)), msgs.map((m) => m.message).join("\n"));
  });

  test("a hedge ('up to') dropped from a figure is flagged", () => {
    const source = "Clients see up to 42% enrollment.";
    const claim = "Clients see 42% enrollment.";
    const found = verifyAttribution(claim, [{ claim, source: 1, quote: source }], [source]);
    assert.ok(found.some((v) => v.type === "dropped-qualifier" && /hedge/.test(v.message)));
  });

  test("a comparison basis dropped from a figure is flagged", () => {
    const claim = "Members attend 3 times more often.";
    const found = verifyAttribution(claim, [{ claim, source: 1, quote: PLAIN }], [PLAIN]);
    assert.ok(found.some((v) => v.type === "dropped-qualifier" && /comparison/.test(v.message)));
  });

  test("a figure in the artifact with no ledger claim is flagged", () => {
    const artifact = "Members attend 3 times more often. We also save you 80% on costs.";
    const claim = "Members attend 3 times more often than non-members in the first month.";
    const found = verifyAttribution(artifact, [{ claim, source: 1, quote: PLAIN }], [PLAIN]);
    assert.ok(found.some((v) => v.type === "figure-unattributed" && v.message.includes("80")));
  });

  test("works for any domain: no product, offer or industry is named in the rules", () => {
    const source = "Pilot clinics cut no-shows by 18% compared with clinics without reminders.";
    const faithful = "Pilot clinics cut no-shows by 18% compared with clinics without reminders.";
    assert.deepEqual(types(faithful, [{ claim: faithful, source: 1, quote: source }], [source]), []);
    const stronger = "Reminders cause an 18% cut in no-shows.";
    assert.ok(types(stronger, [{ claim: stronger, source: 1, quote: source }], [source]).includes("causal-strengthening"));
  });
});

describe("verifyAnswer", () => {
  test("combines unsupported-content and attribution violations; ledger hidden from text", () => {
    const claim = "Members attend 3 times more often.";
    const raw = `${BA}${claim} Plus 90% savings.\n${block([{ claim, source: 1, quote: PLAIN }])}${END}`;
    const out = verifyAnswer(raw, [PLAIN], true, true);
    assert.ok(!out.text.includes("HUBI:CLAIMS"));
    assert.ok(out.verification.phrases.includes("90%"));
    assert.ok(out.verification.phrases.includes("dropped-qualifier"));
    assert.equal(out.attribution.status, "ok");
    assert.equal(out.attribution.claims, 1);
    assert.ok(out.attribution.byType["dropped-qualifier"] >= 1);
  });

  test("a missing ledger is reported, never penalized", () => {
    const out = verifyAnswer(`${BA}Clients see up to 42% enrollment.${END}`, ["Clients see up to 42% enrollment."], true);
    assert.equal(out.attribution.status, "missing");
    assert.equal(out.verification.violations.length, 0);
  });

  test("with the ledger off, attribution is skipped", () => {
    const raw = `${BA}Members attend 3 times more often.\n${block([{ claim: "Members attend 3 times more often.", source: 1, quote: PLAIN }])}${END}`;
    const out = verifyAnswer(raw, [PLAIN], false);
    assert.equal(out.verification.violations.length, 0);
    assert.equal(out.attribution.violations, 0);
  });
});

describe("ledger in the generation flow", () => {
  const result = (text: string): ReasoningResult => ({ ok: true, text, mode: "stream", durationMs: 1000 });
  const sequence = (responses: ReasoningResult[]) => {
    const prompts: string[] = [];
    const engine: ReasoningEngine = async (prompt) => {
      prompts.push(prompt);
      const next = responses[prompts.length - 1];
      if (!next) throw new Error("unexpected extra engine call");
      return next;
    };
    return { engine, prompts };
  };

  const weak = `${BA}Members attend 3 times more often.\n${block([{ claim: "Members attend 3 times more often.", source: 1, quote: PLAIN }])}${END}`;
  const fixed = `${BA}Members attend 3 times more often than non-members in the first month.\n${block([{ claim: "Members attend 3 times more often than non-members in the first month.", source: 1, quote: PLAIN }])}${END}`;

  test("a dropped qualifier triggers one revision, which is accepted when it clears the violation", async () => {
    const { engine, prompts } = sequence([result(weak), result(fixed)]);
    const turn = await generateWithVerification({ engine, prompt: "P", systemPrompt: "S", retrievedTexts: [PLAIN], verify: true, ledger: true, ledgerEnforce: true });
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes("dropped-qualifier") || prompts[1].includes("comparison"));
    assert.equal(turn.verification.revisionAccepted, true);
    assert.equal(turn.verification.attribution?.violations, 0);
    assert.ok(turn.verification.violationsBefore > turn.verification.violationsAfter);
  });

  test("a faithful draft passes with no revision call", async () => {
    const { engine, prompts } = sequence([result(fixed)]);
    const turn = await generateWithVerification({ engine, prompt: "P", systemPrompt: "S", retrievedTexts: [PLAIN], verify: true, ledger: true });
    assert.equal(prompts.length, 1);
    assert.equal(turn.verification.revised, false);
    assert.equal(turn.verification.attribution?.status, "ok");
  });

  test("without the ledger option the same draft is not attribution-checked", async () => {
    const { engine, prompts } = sequence([result(weak)]);
    const turn = await generateWithVerification({ engine, prompt: "P", systemPrompt: "S", retrievedTexts: [PLAIN], verify: true, ledger: false });
    assert.equal(prompts.length, 1);
    assert.equal(turn.verification.violationsBefore, 0);
  });

  test("observe-only by default: attribution is recorded but triggers no revision", async () => {
    const { engine, prompts } = sequence([result(weak)]);
    const turn = await generateWithVerification({ engine, prompt: "P", systemPrompt: "S", retrievedTexts: [PLAIN], verify: true, ledger: true, ledgerEnforce: false });
    assert.equal(prompts.length, 1);
    assert.equal(turn.verification.revised, false);
    assert.ok((turn.verification.attribution?.violations ?? 0) > 0);
  });

  test("HUBI_CLAIM_LEDGER=enforce enables enforcement; unset does not", () => {
    assert.equal(ledgerEnforced({}), false);
    assert.equal(ledgerEnforced({ HUBI_CLAIM_LEDGER: "enforce" }), true);
  });

  test("HUBI_CLAIM_LEDGER=0 disables the ledger; default is on", () => {
    assert.equal(ledgerEnabled({}), true);
    assert.equal(ledgerEnabled({ HUBI_CLAIM_LEDGER: "0" }), false);
    assert.equal(ledgerEnabled({ HUBI_CLAIM_LEDGER: "1" }), true);
  });
});

describe("prompt", () => {
  test("the ledger instruction is present only when requested", () => {
    const decision = { eligible: [], mode: "none", taskRegions: [], taskCountries: [], withheldCount: 0, withheldRegions: [], mismatchCount: 0, mismatchRegions: [] } as never;
    const results = [{ score: 1, chunk: { documentTitle: "Doc", text: PLAIN } }] as never;
    const without = buildPrompt("Write a pitch.", results, [], decision);
    const withLedger = buildPrompt("Write a pitch.", results, [], decision, { ledger: true });
    assert.ok(!without.includes(CLAIMS_OPEN));
    assert.ok(withLedger.includes(CLAIMS_OPEN));
    assert.ok(withLedger.includes(LEDGER_INSTRUCTION.slice(0, 40)));
  });
});
