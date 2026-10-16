import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  splitSentences,
  checkScope,
  checkFigureQualifiers,
  checkNoCausalStrengthening,
  checkUnsupportedValueLanguage,
  comparisonClaimTrigger,
} from "../scripts/lib/claimFidelityChecks.ts";

// Deterministic tests of the Finding #005 check logic (no live model). They
// use sentences taken from the real Finding #005 evidence AND sentences from
// an unrelated domain, to show the checks detect the failure class, not one
// product, region or industry.

describe("splitSentences", () => {
  test("splits on sentence punctuation and on line breaks (list items)", () => {
    assert.deepEqual(splitSentences("One. Two!\n- Three\nFour?"), ["One.", "Two!", "- Three", "Four?"]);
  });
});

describe("checkScope (offer / population / any qualifier)", () => {
  const trigger = /highest engagement|roi/i;
  const qualifier = /smart reminders|add-on/i;

  test("flags a scoped claim restated without its scope (Finding #005 case A shape)", () => {
    const r = checkScope("We help you maximize your ROI by fostering a truly engaged workforce.", trigger, qualifier, "scope");
    assert.equal(r.claimPresent, true);
    assert.equal(r.violations.length, 1);
  });

  test("passes when the scope travels with the claim, in the same sentence", () => {
    const r = checkScope("Companies that turn on Smart Reminders see the highest engagement rates.", trigger, qualifier, "scope");
    assert.equal(r.claimPresent, true);
    assert.deepEqual(r.violations, []);
  });

  test("a qualifier in a different sentence does not count (sentence-level standard)", () => {
    const r = checkScope("Smart Reminders is our add-on. It delivers the highest engagement rates.", trigger, qualifier, "scope");
    assert.equal(r.violations.length, 1);
  });

  test("omission is faithful: no claim, no violation", () => {
    const r = checkScope("Wellhub gives employees one subscription to many gyms.", trigger, qualifier, "scope");
    assert.equal(r.claimPresent, false);
    assert.deepEqual(r.violations, []);
  });

  test("is domain-neutral: same logic on an unrelated claim", () => {
    const r = checkScope(
      "Our trucks cut delivery time by 30%.",
      /30\s?%/,
      /refrigerated|cold-chain/i,
      "population"
    );
    assert.equal(r.violations.length, 1);
  });
});

describe("checkScope window: adjacent-sentence (pronoun-tolerant) variant", () => {
  const trigger = /highest engagement|roi/i;
  const qualifier = /smart reminders|add-on/i;
  // Wording taken from the Finding #005 control run: the add-on is named in the
  // previous sentence and the claim sentence refers to it as "It".
  const pronoun = "Smart Reminders sends employees short, personal prompts. It ultimately boosts your ROI.";

  test("strict mode flags a claim whose qualifier is only in the previous sentence", () => {
    assert.equal(checkScope(pronoun, trigger, qualifier, "scope", "sentence").violations.length, 1);
  });

  test("adjacent mode accepts the previous-sentence qualifier", () => {
    const r = checkScope(pronoun, trigger, qualifier, "scope", "adjacent");
    assert.equal(r.claimPresent, true);
    assert.deepEqual(r.violations, []);
  });

  test("adjacent mode still flags a genuinely broadened claim (no qualifier nearby)", () => {
    const r = checkScope(
      "Wellhub gives employees one subscription. Want to boost your Wellhub ROI?",
      trigger,
      qualifier,
      "scope",
      "adjacent"
    );
    assert.equal(r.violations.length, 1);
  });

  test("adjacent mode only looks one sentence back, and never before the first sentence", () => {
    const twoBack = checkScope("Smart Reminders is our add-on. We love it. It boosts your ROI.", trigger, qualifier, "scope", "adjacent");
    assert.equal(twoBack.violations.length, 1);
    const first = checkScope("It boosts your ROI.", trigger, qualifier, "scope", "adjacent");
    assert.equal(first.violations.length, 1);
  });

  test("every adjacent violation is also a strict violation (adjacent is the conservative count)", () => {
    const samples = [
      pronoun,
      "Wellhub gives employees one subscription. Want to boost your Wellhub ROI?",
      "Smart Reminders is our add-on. We love it. It boosts your ROI.",
      "Companies that turn on Smart Reminders see the highest engagement rates.",
    ];
    for (const text of samples) {
      const strict = checkScope(text, trigger, qualifier, "scope", "sentence").violations;
      const adjacent = checkScope(text, trigger, qualifier, "scope", "adjacent").violations;
      for (const v of adjacent) assert.ok(strict.includes(v), v);
    }
  });

  test("the window also applies to figure qualifiers", () => {
    const pairs = [{ figure: /2\.5\s?x/i, qualifier: /\bus\b/i, what: "region (US)" }];
    const text = "In the US the picture is different. Participation is 2.5x higher.";
    assert.equal(checkFigureQualifiers(text, pairs, "sentence").violations.length, 1);
    assert.deepEqual(checkFigureQualifiers(text, pairs, "adjacent").violations, []);
  });
});

describe("checkFigureQualifiers (region)", () => {
  const pairs = [
    { figure: /2\.5\s?(x|times)/i, qualifier: /\bus\b|u\.s\.|united states/i, what: "region (US)" },
    { figure: /1\.7\s?(x|times)/i, qualifier: /global|worldwide/i, what: "region (Global)" },
  ];

  test("flags the US figure stated without 'US' (Finding #005 case B, run 5)", () => {
    const r = checkFigureQualifiers(
      "For enterprise financial services companies like yours, payroll can boost employee subscription rates by up to 2.5 times.",
      pairs
    );
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /region \(US\)/);
  });

  test("accepts each figure with its own region label", () => {
    const r = checkFigureQualifiers(
      "Subscription rates are 1.7x higher globally, and up to 2.5x higher in the US.",
      pairs
    );
    assert.equal(r.claimPresent, true);
    assert.deepEqual(r.violations, []);
  });

  test("a region label for the OTHER figure does not satisfy this figure", () => {
    const r = checkFigureQualifiers("Rates are 2.5x higher, and 1.7x higher globally.", pairs);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /region \(US\)/);
  });
});

describe("checkNoCausalStrengthening (comparison vs. causality)", () => {
  const trigger = /1\.7\s?x|payroll/i;

  test("flags 'proven to significantly boost' (Finding #005 case B, first sample)", () => {
    const r = checkNoCausalStrengthening(
      "Our solutions, including features like payroll integration, have proven to significantly boost employee participation.",
      trigger
    );
    assert.equal(r.claimPresent, true);
    assert.ok(r.violations.length >= 1);
  });

  test("flags 'can boost ... by 1.7x' even though a figure is present", () => {
    const r = checkNoCausalStrengthening("Enabling payroll integration can boost employee subscription rates by 1.7x globally.", trigger);
    assert.equal(r.violations.length, 1);
  });

  test("accepts a plain comparison", () => {
    const r = checkNoCausalStrengthening(
      "Companies with payroll enabled show 1.7x higher subscription rates than companies without.",
      trigger
    );
    assert.equal(r.claimPresent, true);
    assert.deepEqual(r.violations, []);
  });

  test("is domain-neutral: causal vocabulary on an unrelated comparison", () => {
    const r = checkNoCausalStrengthening("Stores with plants prove to drive 12% more sales.", /12\s?%/);
    assert.equal(r.violations.length, 1);
  });
});

describe("comparisonClaimTrigger (figure or comparative phrase, not the bare metric word)", () => {
  const trigger = comparisonClaimTrigger(/1\.4\s?(x|times)/i, "retention");

  test("does not treat a sentence that merely mentions the metric as a claim (false positive in the first baseline)", () => {
    const sentence = "To further boost that engagement and retention, consider Wellhub's Wellness Challenges.";
    assert.equal(trigger.test(sentence), false);
    const r = checkNoCausalStrengthening(sentence, trigger);
    assert.equal(r.claimPresent, false);
    assert.deepEqual(r.violations, []);
  });

  test("still flags 'proven to work' around the compared figure (the real violation from the first baseline)", () => {
    const sentence =
      "Our Wellness Challenges feature has been proven to work: companies with Wellness Challenges enabled show 1.4x higher member retention compared to those without.";
    const r = checkNoCausalStrengthening(sentence, trigger);
    assert.equal(r.claimPresent, true);
    assert.equal(r.violations.length, 1);
  });

  test("matches comparative phrasing without a figure, and accepts a plain comparison", () => {
    assert.equal(trigger.test("Companies with the feature show higher member retention than companies without."), true);
    assert.equal(trigger.test("Retention is higher for companies with the feature."), true);
    const plain = checkNoCausalStrengthening("Companies with the feature show 1.4x higher retention than companies without.", trigger);
    assert.equal(plain.claimPresent, true);
    assert.deepEqual(plain.violations, []);
  });

  test("known limit: a purely qualitative causal claim with no figure or comparative phrase is not detected", () => {
    assert.equal(trigger.test("Wellness Challenges improve retention."), false);
  });

  test("is domain-neutral: same builder for an unrelated metric", () => {
    const t = comparisonClaimTrigger(/12\s?%/, "sales");
    assert.equal(t.test("Stores with plants post 12% more sales."), true);
    assert.equal(t.test("Plants help drive foot traffic and sales."), false);
  });
});

describe("checkUnsupportedValueLanguage (ROI / value claims)", () => {
  test("flags value language that no retrieved chunk contains", () => {
    const r = checkUnsupportedValueLanguage("Wellhub boosts productivity and delivers a strong ROI.", [
      "Wellhub gives employees one subscription to many gyms.",
    ]);
    assert.equal(r.claimPresent, true);
    assert.equal(r.violations.length, 2);
  });

  test("does not flag a term the sources themselves use (its scope is checked elsewhere)", () => {
    const r = checkUnsupportedValueLanguage("That boosts your ROI.", ["Companies that turn on the add-on see the highest engagement, and that boosts your ROI."]);
    assert.equal(r.claimPresent, true);
    assert.deepEqual(r.violations, []);
  });

  test("is case-insensitive and passes text with no value language", () => {
    assert.deepEqual(checkUnsupportedValueLanguage("Wellhub gives employees one subscription.", []).violations, []);
    assert.equal(checkUnsupportedValueLanguage("A strong Return On Investment.", []).violations.length, 1);
  });
});
