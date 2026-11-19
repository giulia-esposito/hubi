import test from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, planExpansion } from "../lib/retrieval/queryExpansion.ts";
import { inferRegionFromLanguage } from "../lib/applicability/languageRegion.ts";

test("colloquial Portuguese with no cue word is translated, even when the top score looks fine", () => {
  const q = "me fala sobre wellhub+ como escolhero tipo?";
  assert.equal(detectLanguage(q), "unknown");
  const plan = planExpansion(q, 30);
  assert.equal(plan.expand, true);
  assert.equal(plan.reason, "non-english-query");
  assert.deepEqual(plan.targets, ["English"]);
});

test("that rule never turns the language into a region", () => {
  assert.equal(inferRegionFromLanguage(["me fala sobre wellhub+ como escolhero tipo?"]), undefined);
});

test("English questions and very short ones are not affected", () => {
  assert.equal(planExpansion("What are the early cancellation rules?", 30).expand, false);
  assert.equal(planExpansion("early cancellation fee", 30).expand, false); // three words
  assert.equal(planExpansion("brasil", 30).expand, false);
  assert.equal(planExpansion("pricing model per subscriber explained", 30).expand, false); // keyword-style English, no Romance cue word
});
