import type { ReasoningEngine } from "./reasoningEngine.ts";
import type { ReasoningOptions, ReasoningResult } from "./reasoningEngine.claudeCode.ts";

/**
 * Provider resilience and protection, applied around any Reasoning Engine
 * adapter (lib/runtime/reasoningEngine.ts): retries with backoff for transient
 * provider errors, a cap on concurrent model calls per instance, and a
 * request-rate guard. The adapters stay thin; this is the one place the
 * policy lives, so a different provider inherits it.
 *
 * Retry rules, deliberately conservative:
 *   - only errors that are transient by nature (quota / rate limit, 5xx,
 *     unavailable, a dropped connection); auth, bad-request, model-not-found
 *     and a timeout are never retried (a timeout already cost the whole
 *     per-attempt budget);
 *   - only when nothing was produced: once text has reached the caller or the
 *     user, a retry would duplicate or contradict it, so the failure is returned;
 *   - never beyond the total time budget, so retries cannot push a request past
 *     what the user is willing to wait.
 */

export interface ResilienceConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Total wall-clock budget for one call including retries and waiting for a slot. */
  budgetMs: number;
  /** Concurrent model calls per instance; 0 disables the cap. */
  maxConcurrent: number;
  /** How long a call may wait for a slot before it is refused as busy. */
  maxQueueWaitMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  budgetMs: 100_000,
  maxConcurrent: 16,
  maxQueueWaitMs: 15_000,
};

type Env = Record<string, string | undefined>;

function intFrom(raw: string | undefined, fallback: number, min = 0): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** Reads overrides from HUBI_ENGINE_* variables; unset or invalid values keep the defaults. */
export function resilienceConfig(env: Env = process.env): ResilienceConfig {
  return {
    maxAttempts: intFrom(env.HUBI_ENGINE_MAX_ATTEMPTS, DEFAULT_RESILIENCE.maxAttempts, 1),
    baseDelayMs: intFrom(env.HUBI_ENGINE_RETRY_BASE_MS, DEFAULT_RESILIENCE.baseDelayMs, 0),
    maxDelayMs: intFrom(env.HUBI_ENGINE_RETRY_MAX_MS, DEFAULT_RESILIENCE.maxDelayMs, 0),
    budgetMs: intFrom(env.HUBI_ENGINE_BUDGET_MS, DEFAULT_RESILIENCE.budgetMs, 1000),
    maxConcurrent: intFrom(env.HUBI_ENGINE_MAX_CONCURRENT, DEFAULT_RESILIENCE.maxConcurrent, 0),
    maxQueueWaitMs: intFrom(env.HUBI_ENGINE_QUEUE_WAIT_MS, DEFAULT_RESILIENCE.maxQueueWaitMs, 0),
  };
}

const TRANSIENT = /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|resource exhausted|UNAVAILABLE|overloaded|quota|rate.?limit|too many requests|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|INTERNAL/i;
const PERMANENT = /\b(400|401|403|404)\b|PERMISSION_DENIED|UNAUTHENTICATED|INVALID_ARGUMENT|NOT_FOUND|API key|credentials/i;

/** True for an error worth retrying. A timeout and anything that looks permanent are not. */
export function isRetryable(error: string | undefined): boolean {
  if (!error) return false;
  if (error === "timeout") return false;
  if (PERMANENT.test(error)) return false;
  return TRANSIENT.test(error);
}

/** Exponential backoff with full jitter: a uniform wait up to base * 2^(attempt-1), capped. `attempt` is the one that just failed (1-based). */
export function backoffMs(attempt: number, config: ResilienceConfig, random: () => number = Math.random): number {
  const ceiling = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

/** A counting semaphore with a bounded wait. */
export class Limiter {
  private active = 0;
  private waiters: (() => void)[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get inFlight(): number {
    return this.active;
  }

  /** Resolves true with a slot held (call release()), or false when none freed within `waitMs`. */
  async acquire(waitMs: number): Promise<boolean> {
    if (this.limit <= 0 || this.active < this.limit) {
      this.active++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== grant);
        resolve(false);
      }, waitMs);
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve(true);
      };
      this.waiters.push(grant);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

export interface ResilienceHooks {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wraps an engine with the retry policy and the concurrency cap. */
export function withResilience(engine: ReasoningEngine, config: ResilienceConfig = resilienceConfig(), hooks: ResilienceHooks = {}): ReasoningEngine {
  const sleep = hooks.sleep ?? realSleep;
  const now = hooks.now ?? Date.now;
  const limiter = new Limiter(config.maxConcurrent);

  return async (prompt: string, system: string, opts: ReasoningOptions = {}): Promise<ReasoningResult> => {
    const started = now();

    if (!(await limiter.acquire(config.maxQueueWaitMs))) {
      return { ok: false, text: "", mode: "stream", durationMs: now() - started, error: "busy: too many model calls in flight on this instance" };
    }

    // Retrying is safe only while nothing has been produced for the caller.
    let delivered = false;
    const guarded: ReasoningOptions = { ...opts, onDelta: opts.onDelta ? (t) => ((delivered = true), opts.onDelta?.(t)) : undefined };

    let attempts = 0;
    let waited = 0;
    try {
      for (;;) {
        attempts++;
        const result = await engine(prompt, system, guarded);
        const base = { ...result, attempts, retryWaitMs: waited };
        if (result.ok || delivered || result.text !== "" || attempts >= config.maxAttempts || !isRetryable(result.error)) return base;

        const wait = backoffMs(attempts, config, hooks.random);
        if (now() - started + wait >= config.budgetMs) return base;
        await sleep(wait);
        waited += wait;
      }
    } finally {
      limiter.release();
    }
  };
}

export interface RateDecision {
  allowed: boolean;
  /** When refused: how long until the caller may try again. */
  retryAfterMs: number;
}

/**
 * A per-key sliding-window request limiter, in memory. With several instances
 * each keeps its own window, so the effective limit is up to limit x instances:
 * a backstop against a runaway client or a loop, not an exact quota.
 */
export class RateGuard {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  check(key: string): RateDecision {
    if (this.limit <= 0) return { allowed: true, retryAfterMs: 0 };
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: this.windowMs - (t - recent[0]) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.sweep(t);
    return { allowed: true, retryAfterMs: 0 };
  }

  private sweep(t: number): void {
    for (const [key, hits] of this.hits) if (hits.every((h) => t - h >= this.windowMs)) this.hits.delete(key);
  }
}

export interface RateLimits {
  perUserPerMinute: number;
  perInstancePerHour: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { perUserPerMinute: 20, perInstancePerHour: 1500 };

/** HUBI_RATE_LIMIT_PER_MIN and HUBI_MAX_REQUESTS_PER_HOUR; 0 disables a limit. */
export function rateLimits(env: Env = process.env): RateLimits {
  return {
    perUserPerMinute: intFrom(env.HUBI_RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMITS.perUserPerMinute, 0),
    perInstancePerHour: intFrom(env.HUBI_MAX_REQUESTS_PER_HOUR, DEFAULT_RATE_LIMITS.perInstancePerHour, 0),
  };
}

export type RequestVerdict = { allowed: true } | { allowed: false; scope: "user" | "instance"; retryAfterMs: number };

export interface RequestGuard {
  check(callerKey: string): RequestVerdict;
}

/** Combines the per-caller and per-instance limits. The caller key is whatever identifies the user (never logged raw). */
export function createRequestGuard(limits: RateLimits = rateLimits(), now: () => number = Date.now): RequestGuard {
  const perUser = new RateGuard(limits.perUserPerMinute, 60_000, now);
  const perInstance = new RateGuard(limits.perInstancePerHour, 3_600_000, now);
  return {
    check(callerKey: string): RequestVerdict {
      const user = perUser.check(callerKey);
      if (!user.allowed) return { allowed: false, scope: "user", retryAfterMs: user.retryAfterMs };
      const instance = perInstance.check("instance");
      if (!instance.allowed) return { allowed: false, scope: "instance", retryAfterMs: instance.retryAfterMs };
      return { allowed: true };
    },
  };
}
