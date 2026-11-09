import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateHealth, type WindowStats } from "../lib/monitoring/health.ts";

const base: WindowStats = { turns: 40, answerTurns: 36, notCovered: 4, errors: 0, p95LatencyMs: 12000, votes: 20, helpful: 17 };

describe("pilot health rating", () => {
  it("is green when every part is within its limit", () => {
    const h = rateHealth(base);
    assert.equal(h.overall, "green");
    assert.deepEqual(h.reasons, []);
  });
  it("takes the worst part", () => {
    assert.equal(rateHealth({ ...base, helpful: 13 }).overall, "yellow"); // 65%
    assert.equal(rateHealth({ ...base, helpful: 10 }).overall, "red"); // 50%
    assert.equal(rateHealth({ ...base, notCovered: 10 }).overall, "yellow"); // 28%
    assert.equal(rateHealth({ ...base, errors: 2 }).overall, "red"); // 2 of 40 = 5%
  });
  it("rates errors by share of turns", () => {
    assert.equal(rateHealth({ ...base, errors: 1 }).items.find((i) => i.key === "errors")?.rating, "yellow"); // 2.5%
    assert.equal(rateHealth({ ...base, turns: 400, errors: 3 }).items.find((i) => i.key === "errors")?.rating, "green");
  });
  it("does not rate the helpful share from fewer than 10 votes", () => {
    const h = rateHealth({ ...base, votes: 3, helpful: 0 });
    assert.equal(h.items.find((i) => i.key === "helpful")?.rating, "early");
    assert.equal(h.overall, "green");
  });
  it("says it is too early below 10 questions", () => {
    const h = rateHealth({ ...base, turns: 6, answerTurns: 6, notCovered: 6 });
    assert.equal(h.overall, "early");
  });
  it("rates slow answers", () => {
    assert.equal(rateHealth({ ...base, p95LatencyMs: 30000 }).overall, "yellow");
    assert.equal(rateHealth({ ...base, p95LatencyMs: 50000 }).overall, "red");
  });
});
