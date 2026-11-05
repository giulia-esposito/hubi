# P2 items that are decisions or later work (audit 2026-11-04), recorded 2026-11-05

The code items of P2 are done (P2-1, P2-2, P2-7) or tried and not adopted (P2-3, P2-4: `docs/retrieval-benchmark.md`). These three are not code for the pilot. Each records the decision, the reason, and the trigger to revisit, so they are neither forgotten nor built too early.

## P2-5: distributed limits

**Decision: accept per-instance semantics for the pilot, explicitly.**

- The rate limits (`HUBI_RATE_LIMIT_PER_MIN`, `HUBI_MAX_REQUESTS_PER_HOUR`), the model concurrency cap (16) and the circuit breaker are per process. With `maxScale` 20, a caller can in principle receive up to 20 times a limit if requests spread across instances.
- Why this is acceptable now: the limits are a backstop against a runaway client or loop, not a quota; the audience is a controlled internal group behind IAP; the load test showed one instance serving about 60 to 70 turns a minute with no failures; and the real cost control is the Vertex project budget, not these counters.
- **Revisit when:** usage is open beyond a controlled audience, a per-user budget becomes a requirement, or the Vertex bill shows spread-out abuse. Then use a shared store (for example Memorystore or Firestore counters) behind the existing `RequestGuard` interface in `lib/runtime/resilience.ts`; no caller changes are needed. That is a new external dependency, so it needs Platform approval.

## P2-6: telemetry analytics and the knowledge-intelligence loop

**Decision: do not build before there is real traffic; prepare the path.**

- Today: structured events go to Cloud Logging (`docs/pilot-telemetry-and-sessions.md`), five log-based metrics exist, and the evals read the interaction shape. Logs are searchable but not analyzable at volume.
- Plan when traffic exists: a Cloud Logging sink for `jsonPayload.component="hubi"` into a BigQuery dataset in the same project, then three views: unanswered and low-confidence questions by topic (content gaps for Content), feedback by tag and by source document (which sources mislead), and latency and verification cost by turn type. The sink needs the Logs Configuration Writer and BigQuery permissions, which the owner's account does not have (Jira batch), and a retention and access decision for question text, which Legal and InfoSec should confirm first (questions can contain client details despite the guidance).
- **Revisit when:** a few hundred real questions have accumulated, or Content asks for a gap report. Until then the evals and the log metrics are enough.

## P2-8: Google Chat channel and cross-session continuity

**Decision: after launch, as the V1 scope decision of 2026-10-29 already says; the web app stays the pilot interface.**

- What makes Chat cheap later: the chat route already streams a structured event sequence and the conversation is rebuilt from client-sent history, so a Chat adapter would be a thin client that owns its own history store.
- What must come first (Product agreed on 2026-11-05): the source list must stop being server-built text. The server should send structured sources (title, link, which slides), grouped by document with clean titles, with the region and eligibility metadata kept in logs only; each surface then renders them its own way (a collapsed "Sources" control in the web app, a short footer or a button in Chat). Recommendations 1, 2, 3, 4 and 6 of the source-presentation discussion apply; recommendation 5 (friendly caveat wording) was declined.
- Cross-session continuity (resuming prior work in another session or channel) needs a server-side conversation store, which is the privacy and data-retention question the "persistent memory" re-score trigger is about (`docs/production-promotion-plan.md` §9). Do not build it before InfoSec and Legal have ruled.
- **Revisit when:** the pilot has produced a go decision and the front end is being redone.
