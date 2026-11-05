# Implementation Handoff (current snapshot, 2026-11-05)

For a new engineer or a new conversation picking Hubi up. This is a map and a status, not the history: the history is in `Prototype_Plan.md` and `docs/validation-findings.md`. The earlier version of this file (a 2026-08 snapshot that described a local-only prototype and recommended the next milestone) is superseded by this one.

## Where Hubi is

A stakeholder **pilot** is running on Cloud Run (`hubi-pilot`, project `wh-revenue-sandbox`, `us-central1`, internal ingress behind IAP, ISSTD27 sandbox). Reasoning is Gemini 2.5 Flash on Vertex AI using the service's attached identity (no API keys). Content is served from a Cloud Storage bucket; **Google Drive is the source of truth** and the bucket is only a serving layer (the governed automated sync is not built yet, see P0-4b).

Serving revision and commit are always verifiable: `node --experimental-strip-types scripts/deploy.ts verify --env pilot`.

## What exists in code

| Layer | What it does | Where |
|---|---|---|
| Ingestion | DOCX/PPTX parsing, template-aware normalization, chunking; document identity from the Content ID row and the `[RKC-…]` file name (a disagreement is an excluded identity conflict) | `lib/ingestion/` |
| Governance | Content Registry snapshot decides AI Eligibility, status and access level before indexing; excluded content never reaches retrieval, prompts, citations or logs | `lib/governance/`, `config/governance/` |
| Applicability | Approved region map; `unspecified` is never `Global`; region from the question, the pinned context, or the language (pt, de, fr, it, nl; never en or es, which ask) | `lib/applicability/` |
| Retrieval | In-memory BM25, cross-language query expansion with rank fusion, a fact pass for artifact requests, source-selection signals, a scope gate | `lib/retrieval/`, `lib/runtime/retrieveApplicable.ts`, `scopeGate.ts` |
| Prompting | System prompt, retrieved text fenced as data, notices for applicability, audience, source governance | `lib/runtime/promptBuilder.ts` |
| Reasoning | Provider-agnostic engine contract; Gemini adapter with explicit generation parameters, safety settings, cancellation, retries, a circuit breaker and a concurrency cap | `lib/runtime/reasoningEngine*.ts`, `resilience.ts`, `circuitBreaker.ts` |
| Verification | Deterministic claim checks (figures, value language) and an enforced claims ledger with one revision call; an "AI-generated draft" label in the UI | `lib/runtime/claimVerifier.ts`, `claimAttribution.ts`, `verifiedGeneration.ts` |
| Route and UI | NDJSON streaming chat route, readiness and liveness probes, one conversation screen | `app/` |
| Operations | Direct, traceable deploys from an exact commit; telemetry to Cloud Logging; log-based metrics | `scripts/deploy.ts`, `docs/deployment-runbook.md`, `docs/monitoring.md` |

## How to run, test, evaluate, deploy

```bash
npm install
npm run dev                # http://127.0.0.1:3000 (Claude Code engine by default; set HUBI_REASONING_PROVIDER=gemini for Vertex)
npm test                   # offline suite, about 540 tests, needs no model; real-corpus tests skip when "Content Repository" is absent
npx tsc --noEmit
```

Live evals call a model and cost a little (about $0.03 to $0.2 per suite): `eval-applicability`, `eval-context-asking`, `eval-claim-fidelity`, `eval-safety`, `validate-pilot`, and `scripts/load-test.ts`. Outputs go to the gitignored `evals-out/`.

Deploy only with `scripts/deploy.ts plan`, then `deploy --confirm <short commit>`, from a clean `develop` (see `docs/deployment-runbook.md`). Never override ingress, IAP, networking, labels, the service account or env vars.

## Decisions that are not obvious from the code

- GitHub (personal account, `develop` working branch) is the canonical source. Migration to the Wellhub org and CI-driven deploy were **deliberately deferred** by Product.
- RKC-000021 is Not Eligible and must never be re-enabled.
- Regional applicability and "not specified" source regions are **internal**: never written in answers or shown in the source list (Product decision 2026-11-05).
- The claims ledger is enforced by default (`HUBI_CLAIM_LEDGER=observe` reverts), at an accepted cost of about 6 to 9 seconds on artifact turns.
- A Portuguese question maps to Brazil until the user names a country (Portugal is Europe in the approved map).
- CPU throttling stays on for the pilot: the first question after each deploy is slow while the corpus loads (about 7 minutes of background load on throttled CPU, shared with the first request).

## Open items

Tracked with owners and order in `docs/production-readiness-audit-2026-11-04.md` (see its progress log). In short: Drive to GCS governed sync (needs IT), Monitoring alert policies and dashboard access (needs a permissions request), the ISSTD28 promotion path (`docs/production-promotion-plan.md`), source-list redesign for the web app and Google Chat, and the retrieval-quality items.

## Read next

`CLAUDE.md` (principles), `Product_Architecture.md` (concepts), `docs/production-readiness-audit-2026-11-04.md` (state and plan), `docs/validation-findings.md` (decisions), `docs/deployment-runbook.md`, `docs/load-test-2026-11-05.md`.
