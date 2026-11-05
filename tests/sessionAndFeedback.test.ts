import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../lib/runtime/sessionRegistry.ts";
import { parseChatRequest, VALID_ID } from "../lib/runtime/requestSession.ts";

describe("bounded session registry (P2-1)", () => {
  test("a session is reused while it is live", () => {
    const r = new SessionRegistry(10, 1000, () => 0);
    assert.equal(r.getOrCreate("a"), r.getOrCreate("a"));
  });
  test("the least recently used session goes first when the cap is exceeded", () => {
    const r = new SessionRegistry(2, 10_000, () => 0);
    const a = r.getOrCreate("a");
    r.getOrCreate("b");
    r.getOrCreate("a"); // a is now the most recent
    r.getOrCreate("c"); // evicts b
    assert.equal(r.size, 2);
    assert.equal(r.getOrCreate("a"), a, "a was kept");
  });
  test("an idle session expires", () => {
    let t = 0;
    const r = new SessionRegistry(10, 1000, () => t);
    const first = r.getOrCreate("a");
    t = 1001;
    assert.notEqual(r.getOrCreate("a"), first, "a fresh session replaces the expired one");
  });
  test("inventing many session ids cannot grow memory past the cap", () => {
    const r = new SessionRegistry(50, 10_000, () => 0);
    for (let i = 0; i < 5000; i++) r.getOrCreate(`s${i}`);
    assert.equal(r.size, 50);
  });
});

describe("identifier validation", () => {
  test("UUIDs pass; long, spaced or markup-bearing ids do not", () => {
    assert.ok(VALID_ID.test(crypto.randomUUID()));
    assert.equal(VALID_ID.test("x".repeat(101)), false);
    assert.equal(VALID_ID.test("has space"), false);
    assert.equal(VALID_ID.test("<script>"), false);
    assert.equal(parseChatRequest({ sessionId: "x".repeat(500), question: "q" }).ok, false);
    assert.equal(parseChatRequest({ sessionId: crypto.randomUUID(), question: "q" }).ok, true);
  });
});

describe("POST /api/feedback (P2-2)", () => {
  let post: (body: unknown, caller?: string) => Promise<Response>;
  before(async () => {
    process.env.HUBI_LOG_FILE = "0";
    process.env.HUBI_LOG_STDOUT = "0";
    const route = await import("../app/api/feedback/route.ts");
    post = (body, caller = "u@example.com") =>
      route.POST(new Request("http://localhost/api/feedback", { method: "POST", headers: { "Content-Type": "application/json", "x-goog-authenticated-user-email": caller }, body: JSON.stringify(body) }));
  });

  test("valid feedback is accepted", async () => {
    const res = await post({ sessionId: crypto.randomUUID(), interactionId: crypto.randomUUID(), helpful: true });
    assert.equal(res.status, 200);
  });
  test("oversized or malformed ids are refused, not logged", async () => {
    assert.equal((await post({ sessionId: "x".repeat(300), interactionId: "i", helpful: true })).status, 400);
    assert.equal((await post({ sessionId: "s", interactionId: "<b>", helpful: true })).status, 400);
    assert.equal((await post({ sessionId: "s", interactionId: "i" })).status, 400);
  });
  test("one caller cannot flood the log: 429 after the per-minute cap, other callers unaffected", async () => {
    const flood = "flood@example.com";
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await post({ sessionId: "s", interactionId: "i", helpful: false }, flood);
      if (res.status === 429) limited++;
    }
    assert.ok(limited >= 10, `expected 429s, got ${limited}`);
    assert.equal((await post({ sessionId: "s", interactionId: "i", helpful: true }, "other@example.com")).status, 200);
  });
});
