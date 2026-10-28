# Provider resilience and request protection

Before this change a transient provider error (a 429 quota hit, a 503) surfaced to the tester as "Hubi is currently unavailable" on the first failure, there was no cap on concurrent model calls, and nothing stopped a runaway client or loop from spending model budget. Pilot testers will hit quota and bursts, so this is in place before the first deploy.

## What is in place (`lib/runtime/resilience.ts`)

**Retries with backoff**, around every Reasoning Engine adapter (`getReasoningEngine()` returns the wrapped engine; `rawEngine(provider)` returns the bare adapter):

- Retried: rate limit and quota (`429`, `RESOURCE_EXHAUSTED`), `500/502/503/504`, `UNAVAILABLE`, overload, dropped connections.
- Never retried: auth and permission errors, bad requests, model not found, a timeout (it already used a full per-attempt budget), and any error that is not recognizably transient.
- Never retried once text exists: if the adapter produced text, or the caller already received streamed text, a retry would duplicate or contradict it, so the failure is returned. Buffered turns (the claim-verified artifact turns) have no streamed text, so they retry freely.
- Exponential backoff with full jitter (1s, 2s, 4s... capped at 8s), at most 3 attempts, and never beyond a 100s total budget.
- The result carries `attempts` and `retryWaitMs`; both are in the interaction log (`engineAttempts`, `engineRetryWaitMs`), so the share of turns that needed a retry is measurable from real traffic.

**Concurrency cap**: at most 16 model calls in flight per instance. A call waits up to 15s for a slot and is then refused as `busy` instead of queueing without bound.

**Request guard** (`app/api/chat/route.ts`): 20 requests per minute per user (the IAP-authenticated email header; one shared bucket locally) and 1,500 requests per hour per instance. Over the limit the API returns `429` with `Retry-After`, the UI says to wait a few seconds, and a telemetry event records the scope (`user` or `instance`). Windows are in memory per instance, so with several instances the effective ceiling is the limit times the instance count: a backstop against loops and abuse, not an exact quota.

All of it is tunable without a code change and none of it needs a new secret:

| Variable | Default | Meaning |
|---|---|---|
| `HUBI_ENGINE_MAX_ATTEMPTS` | 3 | Model calls per request (1 turns retries off) |
| `HUBI_ENGINE_RETRY_BASE_MS` / `HUBI_ENGINE_RETRY_MAX_MS` | 1000 / 8000 | Backoff base and cap |
| `HUBI_ENGINE_BUDGET_MS` | 100000 | Total time for one call including retries |
| `HUBI_ENGINE_MAX_CONCURRENT` | 16 | In-flight model calls per instance (0 = no cap) |
| `HUBI_ENGINE_QUEUE_WAIT_MS` | 15000 | Wait for a slot before refusing as busy |
| `HUBI_RATE_LIMIT_PER_MIN` | 20 | Requests per user per minute (0 = off) |
| `HUBI_MAX_REQUESTS_PER_HOUR` | 1500 | Requests per instance per hour (0 = off) |

These variables are only needed to change a default. Adding them to the Cloud Run service is a service-config change and follows the deployment runbook (explicit, diffed, approved); the defaults need no config at all.

## Structured planning-mode and turn-kind outputs: decision

Not changed. Both are model self-reports in tags (`[[HUBI:MODE:...]]` first line, `[[HUBI:GROUNDED_ANSWER]]` last line), parsed tolerantly (a missing or malformed tag never breaks the answer; the field becomes `unknown`). Switching to provider-native structured output would give schema-valid fields, but it removes token streaming from the answer (the JSON must be complete before any field is trusted) or needs a second call, which is a UX and cost trade-off for Product.

The evidence so far does not justify it: 0 of 92 local interactions had an `unknown` turn kind, with one live occurrence observed while testing this change (a knowledge-synthesis answer without the trailing tag). `turnKind` and `planningMode` are already in every interaction log, so the pilot measures the real rate. Proposed trigger: if more than about 3% of pilot turns come back `unknown`, propose structured output with the streaming trade-off spelled out; until then the tolerant parser is the right cost.

## Not done

- No circuit breaker (stop calling the provider for a while after repeated failures). With 3 attempts and a 100s budget a sustained outage costs each request about a minute and a half; a breaker would fail fast. Worth adding if the pilot sees real outages.
- No token or cost accounting. The request caps bound the spend roughly (requests times a per-request cost); real token counts would need the provider's usage metadata, which the adapters do not currently surface.
- The per-user limit is per instance, not global (a shared store would be new infrastructure).
