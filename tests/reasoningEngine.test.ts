import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveReasoningProvider, getReasoningEngine } from "../lib/runtime/reasoningEngine.ts";
import { askClaudeCode } from "../lib/runtime/reasoningEngine.claudeCode.ts";
import { askGemini } from "../lib/runtime/reasoningEngine.gemini.ts";

// Deliberately never calls either adapter (no live Claude CLI, no live GCP
// call) -- kept offline and deterministic, same philosophy as the rest of
// tests/*.test.ts. This only exercises the selection logic in
// lib/runtime/reasoningEngine.ts, which is the one thing this migration
// actually adds risk to: picking the wrong provider silently.

const ORIGINAL = process.env.HUBI_REASONING_PROVIDER;

beforeEach(() => {
  delete process.env.HUBI_REASONING_PROVIDER;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.HUBI_REASONING_PROVIDER;
  else process.env.HUBI_REASONING_PROVIDER = ORIGINAL;
});

describe("reasoningEngine provider selection", () => {
  test("defaults to claude-code when unset -- local dev must be unaffected by this migration", () => {
    assert.equal(resolveReasoningProvider(), "claude-code");
    assert.equal(getReasoningEngine(), askClaudeCode);
  });

  test("selects claude-code when explicitly set", () => {
    process.env.HUBI_REASONING_PROVIDER = "claude-code";
    assert.equal(resolveReasoningProvider(), "claude-code");
    assert.equal(getReasoningEngine(), askClaudeCode);
  });

  test("selects gemini when explicitly set", () => {
    process.env.HUBI_REASONING_PROVIDER = "gemini";
    assert.equal(resolveReasoningProvider(), "gemini");
    assert.equal(getReasoningEngine(), askGemini);
  });

  test("is case-insensitive and trims whitespace", () => {
    process.env.HUBI_REASONING_PROVIDER = "  GEMINI  ";
    assert.equal(resolveReasoningProvider(), "gemini");
  });

  test("rejects an unrecognized provider name rather than silently falling back", () => {
    process.env.HUBI_REASONING_PROVIDER = "gpt-4";
    assert.throws(() => resolveReasoningProvider(), /Unknown HUBI_REASONING_PROVIDER/);
  });
});
