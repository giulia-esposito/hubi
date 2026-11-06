import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { namedItemNotice, unmatchedPhrases } from "../lib/runtime/namedTerms.ts";

const SOURCES = [
  "International Check-ins is an add-on SKU for employees who travel abroad. Check-ins are counted per month.",
  "The Global Digital Plan is offered to clients in countries where Wellhub has no physical network.",
];

describe("unmatchedPhrases", () => {
  test("flags a name whose last word is in the sources but which the sources never use", () => {
    const found = unmatchedPhrases("How do I position extra check-ins for a discovery meeting?", SOURCES);
    assert.ok(found.some((p) => p.toLowerCase() === "extra check-ins"), `got ${JSON.stringify(found)}`);
  });
  test("a phrase the sources do use is not flagged, whatever the hyphenation or case", () => {
    assert.deepEqual(unmatchedPhrases("What is the international check ins add-on?", SOURCES).filter((p) => /international/i.test(p)), []);
    assert.deepEqual(unmatchedPhrases("Tell me about Global Digital Plan", SOURCES), []);
  });
  test("a phrase whose last word the sources never use is left alone (nothing similar to confuse it with)", () => {
    assert.deepEqual(unmatchedPhrases("What is the Zebra Sprocket policy?", SOURCES), []);
  });
  test("returns at most the requested number, and nothing without sources", () => {
    assert.ok(unmatchedPhrases("extra check-ins and premium check-ins and bonus check-ins", SOURCES, 2).length <= 2);
    assert.deepEqual(unmatchedPhrases("extra check-ins", []), []);
  });
  test("a longer phrase ending in a listed shorter one is not listed twice", () => {
    const found = unmatchedPhrases("position extra check-ins", SOURCES, 5).map((p) => p.toLowerCase());
    assert.ok(!found.includes("position extra check-ins"));
  });
});

describe("namedItemNotice", () => {
  test("names the phrases and tells the model to say the knowledge does not cover them", () => {
    const notice = namedItemNotice(["extra check-ins"]);
    assert.match(notice, /"extra check-ins"/);
    assert.match(notice, /does not cover the item they named/);
    assert.match(notice, /ignore this notice/);
  });
});
