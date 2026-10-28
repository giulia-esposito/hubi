import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FEEDBACK_TAGS, FEEDBACK_TAG_LABELS, sanitizeFeedbackTags } from "../lib/runtime/feedbackTags.ts";

describe("pilot feedback tags", () => {
  test("every tag has a label, and the pilot's learning goals are covered", () => {
    for (const tag of FEEDBACK_TAGS) assert.ok(FEEDBACK_TAG_LABELS[tag], tag);
    for (const needed of ["wrong-region", "unsupported-claim", "scope-or-causality", "wrong-or-missing-source", "too-slow"]) {
      assert.ok((FEEDBACK_TAGS as readonly string[]).includes(needed), needed);
    }
  });

  test("sanitizeFeedbackTags keeps only known tags, once each", () => {
    assert.deepEqual(sanitizeFeedbackTags(["too-slow", "too-slow", "nonsense", 7, null, "wrong-region"]), ["too-slow", "wrong-region"]);
  });

  test("anything that is not an array yields no tags", () => {
    for (const bad of [undefined, null, "too-slow", 3, { 0: "too-slow" }]) assert.deepEqual(sanitizeFeedbackTags(bad), []);
  });
});
