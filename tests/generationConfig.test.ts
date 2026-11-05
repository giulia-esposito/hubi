import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_TEMPERATURE, DEFAULT_TOP_P, generationConfig } from "../lib/runtime/reasoningEngine.gemini.ts";

describe("generationConfig", () => {
  test("answers are low-temperature and bounded by default, with no seed", () => {
    const c = generationConfig(false, {});
    assert.equal(c.temperature, DEFAULT_TEMPERATURE);
    assert.equal(c.topP, DEFAULT_TOP_P);
    assert.equal(c.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal("seed" in c, false);
    assert.equal("thinkingConfig" in c, false);
  });
  test("helper calls are deterministic and skip thinking", () => {
    const c = generationConfig(true, { HUBI_GEMINI_TEMPERATURE: "1.5" });
    assert.equal(c.temperature, 0);
    assert.deepEqual(c.thinkingConfig, { thinkingBudget: 0 });
  });
  test("environment overrides apply; invalid values keep the defaults", () => {
    const c = generationConfig(false, { HUBI_GEMINI_TEMPERATURE: "0.5", HUBI_GEMINI_SEED: "42", HUBI_GEMINI_MAX_OUTPUT_TOKENS: "4096" });
    assert.equal(c.temperature, 0.5);
    assert.equal(c.seed, 42);
    assert.equal(c.maxOutputTokens, 4096);
    const bad = generationConfig(false, { HUBI_GEMINI_TEMPERATURE: "hot", HUBI_GEMINI_TOP_P: "7", HUBI_GEMINI_MAX_OUTPUT_TOKENS: "5" });
    assert.equal(bad.temperature, DEFAULT_TEMPERATURE);
    assert.equal(bad.topP, DEFAULT_TOP_P);
    assert.equal(bad.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

import { SAFETY_SETTINGS } from "../lib/runtime/reasoningEngine.gemini.ts";
describe("safety settings", () => {
  test("all four harm categories are set explicitly, for answers and helper calls", () => {
    assert.equal(SAFETY_SETTINGS.length, 4);
    for (const fast of [false, true]) assert.deepEqual(generationConfig(fast, {}).safetySettings, SAFETY_SETTINGS);
    assert.ok(SAFETY_SETTINGS.every((s) => s.threshold === "BLOCK_ONLY_HIGH"));
  });
});
