/**
 * A circuit breaker for the model provider (ISSTD28 5.2: agents need automatic
 * pause when behaviour is anomalous). After a run of consecutive transient
 * failures the breaker opens and calls fail immediately, for a cooldown, instead
 * of each request waiting through its own retries against a provider that is
 * down. After the cooldown one probe call is allowed through; success closes the
 * breaker, failure re-opens it.
 *
 * Only transient failures count (quota, 5xx, connection): a bad request or an
 * auth error is a code or configuration problem, not an outage, and must not
 * lock everyone out. A success resets the count.
 */

export interface BreakerConfig {
  /** Consecutive transient failures that open the breaker; 0 disables it. */
  threshold: number;
  /** How long it stays open before allowing one probe. */
  cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 5, cooldownMs: 30_000 };

type Env = Record<string, string | undefined>;

function intFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** HUBI_ENGINE_BREAKER_THRESHOLD (0 = off) and HUBI_ENGINE_BREAKER_COOLDOWN_MS. */
export function breakerConfig(env: Env = process.env): BreakerConfig {
  return {
    threshold: intFrom(env.HUBI_ENGINE_BREAKER_THRESHOLD, DEFAULT_BREAKER.threshold),
    cooldownMs: intFrom(env.HUBI_ENGINE_BREAKER_COOLDOWN_MS, DEFAULT_BREAKER.cooldownMs),
  };
}

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;
  private readonly config: BreakerConfig;
  private readonly now: () => number;

  constructor(config: BreakerConfig = breakerConfig(), now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  get state(): BreakerState {
    if (this.config.threshold <= 0 || this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.config.cooldownMs ? "half-open" : "open";
  }

  /** True when a call may go to the provider. In half-open exactly one probe is admitted until it reports. */
  allow(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open") return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  /** Milliseconds until the next probe is allowed (0 when calls are allowed). */
  retryAfterMs(): number {
    if (this.openedAt === null) return 0;
    return Math.max(0, this.config.cooldownMs - (this.now() - this.openedAt));
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  /** `transient` false (a permanent error) neither opens the breaker nor counts toward it. */
  recordFailure(transient: boolean): void {
    if (this.config.threshold <= 0) return;
    if (!transient) {
      this.probing = false;
      return;
    }
    this.failures++;
    if (this.probing || this.failures >= this.config.threshold) {
      this.openedAt = this.now();
      this.probing = false;
    }
  }
}
