# Monitoring and alerts (pilot)

Definitions live in `config/monitoring/`; nothing here is applied automatically. Creating them changes Cloud Monitoring / Cloud Logging configuration in `wh-revenue-sandbox`, so apply them deliberately, and only with the Monitoring permission (or through the Platform team).

## What is covered

| Signal | Source | Alert |
|---|---|---|
| Failed answers (model, retrieval, unhandled pre-stream) | log metric `hubi_interaction_errors` | > 5 in 10 min |
| Rate-limited requests (429) | log metric `hubi_rate_limited` | metric only, no alert (a rising line is a capacity signal, not an outage) |
| Model circuit breaker open | log metric `hubi_circuit_open` | any |
| Revision started with a provider other than `gemini` | log metric `hubi_wrong_provider` | any |
| Content Registry snapshot older than 60 days | log metric `hubi_stale_registry` | any |
| Memory | built-in `run.googleapis.com/container/memory/utilizations` | p99 > 80% for 10 min |

## Not covered, and why

- **Uptime check on `/api/health`:** the service has internal ingress behind IAP, so Google's external uptime checkers cannot reach it. A private uptime check needs a VPC-side checker and is a Platform decision. `/api/health` (liveness) and `/api/health?ready=1` (readiness) exist for it.
- **Commit mismatch:** `node --experimental-strip-types scripts/deploy.ts verify --env pilot` reports it on demand; an automatic alert would need an "expected commit" source of truth, which belongs with CI-driven deploys (P1-6).
- **Notification channel:** alerts need a channel (email or chat) that Product chooses; the policies below are created without one and do nothing visible until one is attached.

## Apply (after approval)

```bash
for m in interaction_errors rate_limited circuit_open wrong_provider stale_registry; do
  gcloud logging metrics create "hubi_$m" --config-from-file="config/monitoring/metric-$m.json" --project wh-revenue-sandbox
done
```

Alert policies take one JSON object each; `policies.json` holds an array, so split it first (for example with `node -e`) or paste each into the console. Attach the notification channel with `--notification-channels=<channel id>`:

```bash
gcloud alpha monitoring policies create --policy-from-file=<one-policy>.json --project wh-revenue-sandbox
```

Roll back with `gcloud logging metrics delete hubi_<name>` and `gcloud alpha monitoring policies delete <policy id>`.
