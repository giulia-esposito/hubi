import test from "node:test";
import assert from "node:assert/strict";
import { groupIssues, normalizeQuestion } from "../lib/monitoring/issues.ts";

test("normalizes case, accents and punctuation", () => {
  assert.equal(normalizeQuestion("  What are the CURRENT duplicated rules in Salesforce? "), "what are the current duplicated rules in salesforce");
  assert.equal(normalizeQuestion("¿Qué es GDP?"), "que es gdp");
});

test("retries of one question are one issue", () => {
  const events = [
    { question: "What are the duplicated rules?", kind: "Not covered" as const, at: "2026-11-09T20:15:00Z" },
    { question: "what are the duplicated rules", kind: "Not covered" as const, at: "2026-11-09T20:16:00Z" },
    { question: "What are the duplicated rules?", kind: "Reported incorrect" as const, at: "2026-11-09T19:20:00Z" },
  ];
  const [issue] = groupIssues(events, []);
  assert.equal(issue.timesSeen, 3);
  assert.deepEqual(issue.seenAs, ["Reported incorrect", "Not covered"]);
  assert.equal(issue.firstSeen, "2026-11-09");
  assert.equal(issue.helpfulSince, "");
});

test("a helpful vote after the last failure marks it as helpful since", () => {
  const events = [{ question: "Mexico", kind: "Not covered" as const, at: "2026-11-09T10:00:00Z" }];
  const answered = [
    { question: "mexico", at: "2026-11-09T09:00:00Z" },
    { question: "Mexico?", at: "2026-11-10T15:01:00Z" },
  ];
  assert.equal(groupIssues(events, answered)[0].helpfulSince, "2026-11-10");
});
