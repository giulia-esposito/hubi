# Pilot telemetry on Cloud Run

Made so the stakeholder pilot does not lose data when Cloud Run scales or restarts. It needs no new GCP infrastructure.

## 1. Persistent telemetry (stdout -> Cloud Logging)

**Problem:** interaction and feedback records were appended to a file inside the container, lost on every restart and invisible across instances.

**Approach:** on Cloud Run, one JSON object per line on stdout becomes a structured Cloud Logging entry (`jsonPayload`) with no extra resource, IAM grant or dependency (`lib/runtime/telemetry.ts`). Locally the same entries still go to `logs/interactions.jsonl`. Telemetry never throws into a request.

Routing: stdout when `K_SERVICE` is set (Cloud Run) or `HUBI_LOG_STDOUT=1`; file otherwise or with `HUBI_LOG_FILE=1`; `=0` disables either.

Every entry carries `event`, `severity`, `schema` (`hubi-pilot-telemetry-v1`), `timestamp`, and the Cloud Run `service` and `revision`, so feedback maps to a deployed build, plus the provider and model.

| Event | What it records |
|---|---|
| `interaction` | question, final `response`, `planningMode`, `turnKind`, `buffered`, `modelMs`, `latencyMs`; `verification` (checked, violations before/after, revised, accepted, flagged phrases, `extraMs`, and the original `draft` when a revision was attempted); `applicability` and fact-pass decisions; `retrieval` (BM25 query and the top of the raw ranking); `sources[]` with `chunkId`, `documentId`, score, region status and which pass produced each; `continuity` |
| `feedback` | `helpful`, `tags`, `comment`, `waitMs`, `buffered`, joined to its answer by `interactionId` |
| `interaction_error` | engine failure or unexpected exception for a turn, with the same context |

Limits: strings are capped (about 20 KB each) and an entry is shrunk and marked `truncated` before it can approach Cloud Logging's 256 KB limit. Chunk text is never logged, only ids. Entries contain the tester's question and Hubi's answer (as the local log always did); no user identity is added.

Queries (Logs Explorer or `gcloud logging read`):

```
jsonPayload.component="hubi" AND jsonPayload.event="feedback"
jsonPayload.event="feedback" AND jsonPayload.tags="too-slow"
jsonPayload.event="interaction" AND jsonPayload.verification.revised=true
jsonPayload.event="interaction_error"
jsonPayload.interactionId="<id from a feedback entry>"
```

Retention is the project's default log bucket setting (30 days unless changed). A log sink to BigQuery can be added later without code changes.

Verified here: the exact entry shape, size limits, routing, and that real requests against the production build emit the records above. Ingestion into Cloud Logging itself is standard Cloud Run behavior and can only be confirmed after a deploy.
