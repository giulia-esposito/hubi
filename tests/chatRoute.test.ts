import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// Route-level behavior that needs no corpus and no model, so it runs in CI: input validation, the per-user rate
// limit, and the guarantee that a failure before the stream opens is a logged, structured JSON error (P1-3), not a
// framework error page. The streamed happy path needs a corpus and a model and is covered by the live evals.

const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("POST /api/chat", () => {
  let route: { POST: (r: Request) => Promise<Response> };

  before(async () => {
    process.env.HUBI_RATE_LIMIT_PER_MIN = "3";
    process.env.HUBI_LOG_FILE = "0";
    process.env.HUBI_LOG_STDOUT = "0";
    // A content path that does not exist: the knowledge base cannot load, which is a pre-stream failure.
    process.env.HUBI_CONTENT_REPOSITORY_PATH = "does-not-exist-hubi-test";
    route = await import("../app/api/chat/route.ts");
  });

  test("a body that is not JSON is a 400, not a crash", async () => {
    const res = await post(route, "{not json", { "x-goog-authenticated-user-email": "a@example.com" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /required/);
  });

  test("a missing question or session id is a 400", async () => {
    assert.equal((await post(route, { sessionId: "s1" }, { "x-goog-authenticated-user-email": "b@example.com" })).status, 400);
    assert.equal((await post(route, { question: "hi" }, { "x-goog-authenticated-user-email": "b@example.com" })).status, 400);
  });

  test("a failure before the stream opens is a structured JSON 500", async () => {
    const res = await post(route, { sessionId: "s2", question: "What is Wellhub?" }, { "x-goog-authenticated-user-email": "c@example.com" });
    assert.equal(res.status, 500);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.error, "internal");
    assert.ok(typeof body.message === "string" && body.message.length > 0);
    assert.ok(!JSON.stringify(body).includes("does-not-exist-hubi-test"), "internal paths must not leak to the user");
  });

  test("the per-user rate limit answers 429 with Retry-After, and is per caller", async () => {
    const caller = { "x-goog-authenticated-user-email": "d@example.com" };
    for (let i = 0; i < 3; i++) await post(route, { sessionId: "s3", question: "q" }, caller);
    const limited = await post(route, { sessionId: "s3", question: "q" }, caller);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
    assert.equal((await limited.json()).error, "rate-limited");
    const other = await post(route, { sessionId: "s4", question: "q" }, { "x-goog-authenticated-user-email": "e@example.com" });
    assert.notEqual(other.status, 429);
  });
});
