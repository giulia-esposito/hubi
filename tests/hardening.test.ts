import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scrubText, scrubEntry, scrubEnabled } from "../lib/runtime/redact.ts";
import { actorForLog, ipFromHeaders, userFromHeaders, actorLoggingEnabled, callerKindFromHeaders } from "../lib/runtime/actor.ts";
import { CircuitBreaker, breakerConfig, DEFAULT_BREAKER } from "../lib/runtime/circuitBreaker.ts";
import { buildTelemetryEntry } from "../lib/runtime/telemetry.ts";
import { withResilience, type ResilienceConfig } from "../lib/runtime/resilience.ts";
import type { ReasoningEngine, ReasoningResult } from "../lib/runtime/reasoningEngine.ts";

// Offline, deterministic: the logging scrub, actor handling and the provider
// circuit breaker are pure logic exercised with fake headers, engines and clocks.

describe("log scrubbing", () => {
  test("emails and phone-like numbers are replaced; ordinary text is untouched", () => {
    assert.equal(scrubText("Contact maria.silva@client-corp.com.br or +55 11 98765-4321 about the deal"), "Contact [email] or [number] about the deal");
    assert.equal(scrubText("call (415) 555-0132 today"), "call [number] today");
    assert.equal(scrubText("How do I create effective cadences in Salesloft?"), "How do I create effective cadences in Salesloft?");
  });

  test("dates, years, prices, versions and ids are not mistaken for phone numbers", () => {
    for (const s of ["on 2026-10-29", "in 2026", "price 1,200,000", "version 2.5.1", "RKC-000012", "chunk RKC-000012::s3.1", "Tier 1 in Brazil", "up to 42%", "10:15:30"]) {
      assert.equal(scrubText(s), s, s);
    }
  });

  test("an international number with a plus needs fewer digits", () => {
    assert.equal(scrubText("ring +44 20 7946"), "ring [number]");
  });

  test("only free-text fields of a log entry are scrubbed; ids and urls are left exactly as they are", () => {
    const entry = {
      interactionId: "123e4567-e89b-12d3-a456-426614174000",
      question: "email me at ana@corp.com",
      response: "Sure: [number]",
      sources: [{ citationUrl: "https://example.com/a?x=5551234567", chunkId: "RKC-000012::s3" }],
      verification: { draft: "write to bob@corp.com", ledger: [{ claim: "call 5551234567890", quote: "q" }] },
      retrieval: { query: "joe@corp.com pricing", expansion: { terms: "pricing" } },
    };
    const out = scrubEntry(entry);
    assert.equal(out.interactionId, entry.interactionId);
    assert.equal(out.question, "email me at [email]");
    assert.equal(out.sources[0].citationUrl, entry.sources[0].citationUrl);
    assert.equal(out.verification.draft, "write to [email]");
    assert.equal(out.verification.ledger[0].claim, "call [number]");
    assert.equal(out.retrieval.query, "[email] pricing");
    assert.equal(entry.question, "email me at ana@corp.com", "the input is not modified");
  });

  test("telemetry entries are scrubbed by default and left alone with HUBI_LOG_SCRUB=0", () => {
    const record = { type: "interaction", question: "ping ana@corp.com", response: "ok" };
    assert.equal(buildTelemetryEntry("interaction", record, {}).question, "ping [email]");
    assert.equal(buildTelemetryEntry("interaction", record, { HUBI_LOG_SCRUB: "0" }).question, "ping ana@corp.com");
    assert.equal(scrubEnabled({}), true);
    assert.equal(scrubEnabled({ HUBI_LOG_SCRUB: "0" }), false);
  });
});

describe("actor logging", () => {
  const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

  test("it is off unless HUBI_LOG_ACTOR=1: no user or IP is ever returned", () => {
    const h = headers({ "x-goog-authenticated-user-email": "accounts.google.com:ana@corp.com", "x-forwarded-for": "10.1.2.3" });
    assert.equal(actorLoggingEnabled({}), false);
    assert.equal(actorForLog(h, {}), undefined);
    assert.equal(actorForLog(h, { HUBI_LOG_ACTOR: "0" }), undefined);
  });

  test("when on, the IAP user loses its provider prefix and the first forwarded address is the client", () => {
    const h = headers({ "x-goog-authenticated-user-email": "accounts.google.com:ana@corp.com", "x-forwarded-for": "10.1.2.3, 34.1.1.1" });
    assert.deepEqual(actorForLog(h, { HUBI_LOG_ACTOR: "1" }), { user: "ana@corp.com", ip: "10.1.2.3" });
    assert.equal(userFromHeaders(h), "ana@corp.com");
    assert.equal(ipFromHeaders(h), "10.1.2.3");
  });

  test("missing headers give no actor; values are bounded", () => {
    assert.equal(actorForLog(headers({}), { HUBI_LOG_ACTOR: "1" }), undefined);
    assert.equal(userFromHeaders(headers({ "x-goog-authenticated-user-email": "x".repeat(5000) }))?.length, 200);
  });
});

describe("caller kind (does the request guard see the IAP user?)", () => {
  const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

  test("iap when the proxy's user header is present, anonymous when it is not or is blank", () => {
    assert.equal(callerKindFromHeaders(headers({ "x-goog-authenticated-user-email": "accounts.google.com:ana@corp.com" })), "iap");
    assert.equal(callerKindFromHeaders(headers({})), "anonymous");
    assert.equal(callerKindFromHeaders(headers({ "x-goog-authenticated-user-email": "   " })), "anonymous");
  });

  test("it reveals nothing about the user, and works with actor logging off", () => {
    const h = headers({ "x-goog-authenticated-user-email": "accounts.google.com:ana@corp.com", "x-forwarded-for": "10.1.2.3" });
    assert.equal(actorForLog(h, {}), undefined);
    const kind = callerKindFromHeaders(h);
    assert.ok(!kind.includes("ana") && !kind.includes("10.1"));
  });
});

describe("circuit breaker", () => {
  const cfg = { threshold: 3, cooldownMs: 1000 };

  test("opens after consecutive transient failures, then fails fast", () => {
    let t = 0;
    const b = new CircuitBreaker(cfg, () => t);
    for (let i = 0; i < 3; i++) {
      assert.equal(b.allow(), true);
      b.recordFailure(true);
    }
    assert.equal(b.state, "open");
    assert.equal(b.allow(), false);
    assert.equal(b.retryAfterMs(), 1000);
    t = 400;
    assert.equal(b.retryAfterMs(), 600);
  });

  test("a success resets the count; permanent errors never count", () => {
    const b = new CircuitBreaker(cfg, () => 0);
    b.recordFailure(true);
    b.recordFailure(true);
    b.recordSuccess();
    b.recordFailure(true);
    b.recordFailure(true);
    assert.equal(b.state, "closed");
    for (let i = 0; i < 10; i++) b.recordFailure(false);
    assert.equal(b.state, "closed");
  });

  test("after the cooldown one probe is admitted: success closes it, failure re-opens it", () => {
    let t = 0;
    const b = new CircuitBreaker(cfg, () => t);
    for (let i = 0; i < 3; i++) b.recordFailure(true);
    t = 1000;
    assert.equal(b.state, "half-open");
    assert.equal(b.allow(), true);
    assert.equal(b.allow(), false, "only one probe at a time");
    b.recordFailure(true);
    assert.equal(b.state, "open");
    t = 2100;
    assert.equal(b.allow(), true);
    b.recordSuccess();
    assert.equal(b.state, "closed");
    assert.equal(b.allow(), true);
  });

  test("a threshold of 0 disables it; configuration reads the environment", () => {
    const off = new CircuitBreaker({ threshold: 0, cooldownMs: 1000 }, () => 0);
    for (let i = 0; i < 20; i++) off.recordFailure(true);
    assert.equal(off.allow(), true);
    assert.deepEqual(breakerConfig({}), DEFAULT_BREAKER);
    assert.deepEqual(breakerConfig({ HUBI_ENGINE_BREAKER_THRESHOLD: "2", HUBI_ENGINE_BREAKER_COOLDOWN_MS: "500" }), { threshold: 2, cooldownMs: 500 });
    assert.deepEqual(breakerConfig({ HUBI_ENGINE_BREAKER_THRESHOLD: "abc" }), DEFAULT_BREAKER);
  });
});

describe("breaker inside the resilience wrapper", () => {
  const fail = (error: string): ReasoningResult => ({ ok: false, text: "", mode: "stream", durationMs: 1, error });
  const ok = (): ReasoningResult => ({ ok: true, text: "fine", mode: "stream", durationMs: 1 });
  const CONFIG: ResilienceConfig = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, budgetMs: 60_000, maxConcurrent: 0, maxQueueWaitMs: 0 };

  test("repeated outages open the breaker; later calls do not reach the provider", async () => {
    let calls = 0;
    const engine: ReasoningEngine = async () => (calls++, fail("503 UNAVAILABLE"));
    const wrapped = withResilience(engine, CONFIG, {}, new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 }));
    await wrapped("p", "s");
    await wrapped("p", "s");
    assert.equal(calls, 2);
    const refused = await wrapped("p", "s");
    assert.equal(calls, 2, "the third call never reached the provider");
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /^circuit-open/);
  });

  test("a timeout counts as an outage; an auth error does not", async () => {
    const b1 = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    const timeouts = withResilience(async () => fail("timeout"), CONFIG, {}, b1);
    await timeouts("p", "s");
    await timeouts("p", "s");
    assert.equal(b1.state, "open");
    const b2 = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    const denied = withResilience(async () => fail("403 PERMISSION_DENIED"), CONFIG, {}, b2);
    for (let i = 0; i < 5; i++) await denied("p", "s");
    assert.equal(b2.state, "closed");
  });

  test("a healthy call after the cooldown closes it again", async () => {
    let t = 0;
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 }, () => t);
    let healthy = false;
    const wrapped = withResilience(async () => (healthy ? ok() : fail("503 UNAVAILABLE")), CONFIG, {}, b);
    await wrapped("p", "s");
    assert.equal(b.state, "open");
    healthy = true;
    t = 1500;
    assert.equal((await wrapped("p", "s")).ok, true);
    assert.equal(b.state, "closed");
  });

  test("when the breaker opens during a retry, the caller gets the real error, not a made-up one", async () => {
    let calls = 0;
    const engine: ReasoningEngine = async () => (calls++, fail("429 RESOURCE_EXHAUSTED"));
    const wrapped = withResilience(engine, { ...CONFIG, maxAttempts: 3 }, { sleep: async () => {}, random: () => 0 }, new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 }));
    const result = await wrapped("p", "s");
    assert.equal(calls, 2);
    assert.match(String(result.error), /429/);
  });
});
