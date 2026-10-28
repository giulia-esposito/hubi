import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RESILIENCE,
  DEFAULT_RATE_LIMITS,
  Limiter,
  RateGuard,
  backoffMs,
  createRequestGuard,
  isRetryable,
  rateLimits,
  resilienceConfig,
  withResilience,
  type ResilienceConfig,
} from "../lib/runtime/resilience.ts";
import type { ReasoningEngine, ReasoningResult } from "../lib/runtime/reasoningEngine.ts";
import { getReasoningEngine } from "../lib/runtime/reasoningEngine.ts";

// Offline: the policy is exercised with fake engines and a fake clock, so what
// is tested is the decision logic, never a provider.

const ok = (text = "fine"): ReasoningResult => ({ ok: true, text, mode: "stream", durationMs: 10 });
const fail = (error: string, text = ""): ReasoningResult => ({ ok: false, text, mode: "stream", durationMs: 10, error });

const CONFIG: ResilienceConfig = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000, budgetMs: 60_000, maxConcurrent: 4, maxQueueWaitMs: 50 };

function sequence(results: ReasoningResult[], onCall?: (opts: Parameters<ReasoningEngine>[2]) => void) {
  let calls = 0;
  const engine: ReasoningEngine = async (_p, _s, opts) => {
    onCall?.(opts);
    const next = results[calls++];
    if (!next) throw new Error("unexpected extra engine call");
    return next;
  };
  return { engine, calls: () => calls };
}

function clock() {
  let t = 0;
  const waits: number[] = [];
  return { now: () => t, sleep: async (ms: number) => ((t += ms), void waits.push(ms)), waits, random: () => 1 };
}

describe("error classification", () => {
  test("rate limits, 5xx and dropped connections are retryable", () => {
    for (const e of ["429 Too Many Requests", "RESOURCE_EXHAUSTED: quota", "Resource exhausted", "503 UNAVAILABLE", "got status: 500", "fetch failed", "read ECONNRESET", "model is overloaded", "rate limit exceeded"]) {
      assert.equal(isRetryable(e), true, e);
    }
  });

  test("auth, bad requests, missing models, timeouts and unknown errors are not", () => {
    for (const e of ["timeout", "403 PERMISSION_DENIED", "401 UNAUTHENTICATED", "400 INVALID_ARGUMENT", "404 NOT_FOUND model", "Could not load the default credentials", "something odd", ""]) {
      assert.equal(isRetryable(e), false, e);
    }
    assert.equal(isRetryable(undefined), false);
  });

  test("a permanent marker wins over a transient one", () => {
    assert.equal(isRetryable("404 NOT_FOUND ... 503"), false);
  });
});

describe("backoff", () => {
  test("is exponential with full jitter and capped", () => {
    assert.equal(backoffMs(1, CONFIG, () => 1), 1000);
    assert.equal(backoffMs(2, CONFIG, () => 1), 2000);
    assert.equal(backoffMs(3, CONFIG, () => 1), 4000);
    assert.equal(backoffMs(10, CONFIG, () => 1), 8000);
    assert.equal(backoffMs(3, CONFIG, () => 0), 0);
    assert.equal(backoffMs(2, CONFIG, () => 0.5), 1000);
  });
});

describe("retry policy", () => {
  test("a transient failure is retried and the successful result carries the attempt count", async () => {
    const { engine, calls } = sequence([fail("429 RESOURCE_EXHAUSTED"), fail("503 UNAVAILABLE"), ok()]);
    const c = clock();
    const result = await withResilience(engine, CONFIG, c)("p", "s");
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(calls(), 3);
    assert.deepEqual(c.waits, [1000, 2000]);
    assert.equal(result.retryWaitMs, 3000);
  });

  test("gives up after maxAttempts and returns the last error", async () => {
    const { engine, calls } = sequence([fail("429"), fail("429"), fail("429")]);
    const result = await withResilience(engine, CONFIG, clock())("p", "s");
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 3);
    assert.equal(calls(), 3);
  });

  test("a permanent error is returned at once, with one attempt", async () => {
    const { engine, calls } = sequence([fail("403 PERMISSION_DENIED")]);
    const result = await withResilience(engine, CONFIG, clock())("p", "s");
    assert.equal(result.ok, false);
    assert.equal(calls(), 1);
    assert.equal(result.attempts, 1);
  });

  test("a timeout is not retried", async () => {
    const { engine, calls } = sequence([fail("timeout")]);
    await withResilience(engine, CONFIG, clock())("p", "s");
    assert.equal(calls(), 1);
  });

  test("a failure after text was produced is not retried (it would duplicate or contradict it)", async () => {
    const { engine, calls } = sequence([fail("503 UNAVAILABLE", "partial answer")]);
    const result = await withResilience(engine, CONFIG, clock())("p", "s");
    assert.equal(calls(), 1);
    assert.equal(result.text, "partial answer");
  });

  test("a failure after the caller already received streamed text is not retried", async () => {
    const received: string[] = [];
    const { engine, calls } = sequence([fail("503 UNAVAILABLE")], (opts) => opts?.onDelta?.("hello"));
    const result = await withResilience(engine, CONFIG, clock())("p", "s", { onDelta: (t) => received.push(t) });
    assert.deepEqual(received, ["hello"]);
    assert.equal(calls(), 1);
    assert.equal(result.ok, false);
  });

  test("a retry that would exceed the time budget is not attempted", async () => {
    const { engine, calls } = sequence([fail("429"), ok()]);
    const c = clock();
    const result = await withResilience(engine, { ...CONFIG, budgetMs: 500 }, c)("p", "s");
    assert.equal(calls(), 1);
    assert.equal(result.ok, false);
    assert.deepEqual(c.waits, []);
  });

  test("a first-try success reports one attempt and no waiting", async () => {
    const { engine } = sequence([ok()]);
    const result = await withResilience(engine, CONFIG, clock())("p", "s");
    assert.equal(result.attempts, 1);
    assert.equal(result.retryWaitMs, 0);
  });
});

describe("concurrency cap", () => {
  test("a call that cannot get a slot in time is refused as busy, and slots free up afterwards", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine: ReasoningEngine = async () => (await gate, ok());
    const wrapped = withResilience(engine, { ...CONFIG, maxConcurrent: 1, maxQueueWaitMs: 20 });
    const first = wrapped("p", "s");
    const second = await wrapped("p", "s");
    assert.equal(second.ok, false);
    assert.match(String(second.error), /^busy/);
    release();
    assert.equal((await first).ok, true);
    assert.equal((await wrapped("p", "s")).ok, true);
  });

  test("a waiting call proceeds as soon as a slot is released", async () => {
    const limiter = new Limiter(1);
    assert.equal(await limiter.acquire(10), true);
    const waiting = limiter.acquire(1000);
    limiter.release();
    assert.equal(await waiting, true);
    assert.equal(limiter.inFlight, 1);
  });

  test("a limit of 0 disables the cap", async () => {
    const limiter = new Limiter(0);
    for (let i = 0; i < 50; i++) assert.equal(await limiter.acquire(0), true);
  });
});

describe("request guard", () => {
  test("a user over the per-minute limit is refused with a retry time; the window then slides", () => {
    let t = 0;
    const guard = new RateGuard(3, 60_000, () => t);
    for (let i = 0; i < 3; i++) assert.equal(guard.check("a").allowed, true);
    const blocked = guard.check("a");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 60_000);
    assert.equal(guard.check("b").allowed, true);
    t = 61_000;
    assert.equal(guard.check("a").allowed, true);
  });

  test("the per-instance hourly cap applies across users, and a refusal does not consume it", () => {
    let t = 0;
    const guard = createRequestGuard({ perUserPerMinute: 10, perInstancePerHour: 4 }, () => t);
    assert.equal(guard.check("a").allowed, true);
    assert.equal(guard.check("b").allowed, true);
    assert.equal(guard.check("c").allowed, true);
    assert.equal(guard.check("d").allowed, true);
    const verdict = guard.check("e");
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.allowed === false && verdict.scope, "instance");
    t = 3_600_001;
    assert.equal(guard.check("e").allowed, true);
  });

  test("the per-user scope is reported when a single user is over their limit", () => {
    const guard = createRequestGuard({ perUserPerMinute: 1, perInstancePerHour: 100 }, () => 0);
    guard.check("a");
    const verdict = guard.check("a");
    assert.equal(verdict.allowed === false && verdict.scope, "user");
  });

  test("a limit of 0 disables it", () => {
    const guard = createRequestGuard({ perUserPerMinute: 0, perInstancePerHour: 0 }, () => 0);
    for (let i = 0; i < 100; i++) assert.equal(guard.check("a").allowed, true);
  });
});

describe("configuration", () => {
  test("defaults apply when nothing is set, and invalid values are ignored", () => {
    assert.deepEqual(resilienceConfig({}), DEFAULT_RESILIENCE);
    assert.deepEqual(rateLimits({}), DEFAULT_RATE_LIMITS);
    assert.deepEqual(resilienceConfig({ HUBI_ENGINE_MAX_ATTEMPTS: "abc", HUBI_ENGINE_BUDGET_MS: "-5" }), DEFAULT_RESILIENCE);
  });

  test("environment overrides are honored; one attempt disables retries", () => {
    assert.equal(resilienceConfig({ HUBI_ENGINE_MAX_ATTEMPTS: "1" }).maxAttempts, 1);
    assert.equal(resilienceConfig({ HUBI_ENGINE_MAX_CONCURRENT: "0" }).maxConcurrent, 0);
    assert.equal(rateLimits({ HUBI_RATE_LIMIT_PER_MIN: "5", HUBI_MAX_REQUESTS_PER_HOUR: "0" }).perUserPerMinute, 5);
    assert.equal(rateLimits({ HUBI_MAX_REQUESTS_PER_HOUR: "0" }).perInstancePerHour, 0);
  });

  test("the runtime engine is built once per provider so its concurrency cap is shared", () => {
    assert.equal(getReasoningEngine(), getReasoningEngine());
  });
});
