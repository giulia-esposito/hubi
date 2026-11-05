# Hubi — GCP Pilot Deployment Guide

**Scope of this document:** how to run Hubi's *runtime* on Google Cloud Platform for the pilot — Cloud Run hosting, Gemini via Vertex AI as the reasoning engine, and the Content Repository served from Cloud Storage. This is an infrastructure/runtime change, not a product architecture change: Task Planning, Retrieval, and Governance/Applicability are unchanged (still not implemented in code — see `Implementation_Handoff.md`), and **Claude Code remains the engineering environment** for building Hubi. Nothing here affects `npm run dev`.

For the code-level design of the two things that changed, see:
- `lib/runtime/reasoningEngine.ts` — the provider-selection layer
- `lib/ingestion/contentSource.ts` — the GCS/local content loader

---

## 1. What actually changes between local and Cloud Run

| | Local development (unchanged) | Cloud Run pilot |
|---|---|---|
| Reasoning engine | Claude Code CLI (`claude auth login` on this machine) | Gemini via Vertex AI (service identity, no key) |
| Content Repository | Local `Content Repository/` folder | Downloaded from a GCS bucket at container startup |
| Network bind | `127.0.0.1` only | `0.0.0.0`, port from `$PORT` |
| Selected by | Doing nothing (these are the defaults) | Environment variables on the Cloud Run service |

Nothing about retrieval, prompt construction, citation building, turn-kind extraction, or interaction logging changes — the same `lib/runtime/promptBuilder.ts`, `lib/runtime/turnKind.ts`, `lib/runtime/citationBuilder.ts`, and `lib/runtime/interactionLog.ts` run unmodified regardless of which reasoning engine or content source is active.

---

## 2. Required GCP APIs

Enable on the target project:

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  cloudbuild.googleapis.com
```

(`cloudbuild.googleapis.com` is needed only if deploying via `gcloud run deploy --source .`, which builds the image for you. Secret Manager is intentionally **not** in this list — the recommended auth model needs no secrets.)

---

## 3. Service identity and IAM (no manually distributed keys)

Create one dedicated service account for Hubi:

```bash
gcloud iam service-accounts create hubi-runtime \
  --display-name="Hubi Cloud Run runtime identity"
```

Grant it exactly two roles, scoped as tightly as the tooling allows:

```bash
# Vertex AI: call Gemini
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:hubi-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Cloud Storage: read-only on the one Content Repository bucket
gcloud storage buckets add-iam-policy-binding gs://YOUR_BUCKET_NAME \
  --member="serviceAccount:hubi-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
```

No JSON key is ever created for this service account. Cloud Run attaches it directly to the running service; the app authenticates via Application Default Credentials, which resolve automatically to that identity — this is what `lib/runtime/reasoningEngine.gemini.ts` and `lib/ingestion/contentSource.ts` both rely on.

**Institutionalization path (per the product decision to start on Marina's personal GCP access):** for the initial proof of value, Marina's own `gcloud` credentials may be used to run every command in this guide and to validate the deployed service works. Nothing in the deployed *runtime* depends on her personal identity — the Cloud Run service itself only ever uses the `hubi-runtime` service account above. Moving from "Marina's access provisioned it" to "a team-owned account provisions it" later is an IAM/ops change, not a code change.

---

## 4. Knowledge files: Cloud Storage bucket structure

Create one bucket and upload the Content Repository into it, mirroring its local folder structure exactly:

```bash
gcloud storage buckets create gs://YOUR_BUCKET_NAME --location=us-central1

gcloud storage rsync "Content Repository" gs://YOUR_BUCKET_NAME/content-repository \
  --recursive
```

(`--recursive` mirrors subfolders; re-running `rsync` after content changes only uploads the diff.)

Resulting bucket layout:

```
gs://YOUR_BUCKET_NAME/
  content-repository/
    <same file tree as the local "Content Repository" folder>
```

Set `HUBI_GCS_PREFIX=content-repository` (see §6) so multiple things can share one bucket later without collision.

### How loading actually works

`lib/ingestion/contentSource.ts`:
1. On the **first** chat request after a cold start, lists every object under `gs://<bucket>/<prefix>` and downloads each one into a fresh temp directory on the container's local (ephemeral) disk.
2. Runs the exact same `ingestContentRepository()` used locally against that temp directory.
3. Caches the resulting in-memory retrieval index for the lifetime of that container instance (same singleton pattern `lib/runtime/knowledgeBase.ts` already used for the local folder — this migration only changed *where* the bytes come from, not the once-per-process caching behavior).

### Implications this accepts, deliberately, for the pilot

- **Cold-start latency:** the first request to a fresh container instance pays the full download+ingest cost (network transfer of the whole corpus, currently ~2GB, plus ~1-2s of parsing per the existing ingestion benchmarks). Subsequent requests to that same warm instance pay nothing extra.
  - **Mitigation for the pilot:** set Cloud Run `--min-instances=1` so a cold start only happens on deploys, not on every scale-to-zero cycle. This is a cost/latency trade-off worth making explicitly, not silently.
- **Statelessness:** Cloud Run may run multiple instances or replace an instance at any time. Each instance independently downloads and ingests its own copy — there is no shared/warmed state across instances. This is correct (each instance ends up with the same data) but means N instances each pay the download cost once.
- **No incremental sync:** every cold start re-downloads everything; there's no delta/version check. Acceptable for a ~2GB corpus at pilot scale; revisit if the corpus grows substantially or update frequency increases.
- **Ephemeral only:** the downloaded copy lives on the container's local disk and disappears when the instance is torn down. Nothing is written back to GCS by the app — Hubi remains read-only with respect to the Content Repository, matching Architecture.md §17.

### Local development fallback (unchanged, on by default)

`HUBI_CONTENT_SOURCE` defaults to `local`. With it unset (the normal case for every developer using Claude Code locally), `contentSource.ts` returns the local `"Content Repository"` path exactly as before this migration — no GCS credentials, bucket, or network access are ever required to run `npm run dev`.

---

## 5. Environment variables

Copy `.env.example` to `.env.local` for local overrides (gitignored). On Cloud Run, set these as plain service environment variables — **none of them are secrets** under this auth model, so none belong in Secret Manager:

| Variable | Local default | Cloud Run pilot value |
|---|---|---|
| `HUBI_REASONING_PROVIDER` | `claude-code` (unset) | `gemini` |
| `GOOGLE_CLOUD_PROJECT` | unused | your GCP project ID |
| `GOOGLE_CLOUD_LOCATION` | unused | e.g. `us-central1` |
| `HUBI_GEMINI_MODEL` | unused | e.g. `gemini-2.5-flash` |
| `HUBI_CONTENT_SOURCE` | `local` (unset) | `gcs` |
| `HUBI_GCS_BUCKET` | unused | your bucket name |
| `HUBI_GCS_PREFIX` | unused | `content-repository` |
| `PORT` | n/a (dev/start scripts pin 127.0.0.1 without a custom port) | injected automatically by Cloud Run — never set manually |

---

## 5a. Validate one isolated Gemini/Vertex AI call before going further

Before wiring anything else, confirm basic auth/project/model access works at all:

```bash
gcloud auth application-default login   # if running this from a laptop, not Cloud Run
export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
npm run validate-gemini
```

`scripts/validate-gemini.mjs` makes one standalone call, deliberately outside `lib/runtime/reasoningEngine.gemini.ts`, so a failure here points at auth/project/SDK setup rather than anything in Hubi's own adapter. This is also the script that will surface the `vertexai`-vs-`enterprise` constructor-option question flagged in §8 — if it fails with an "unknown option" style error, that's the fix to make, and it belongs in exactly one place (`reasoningEngine.gemini.ts`'s `getClient()`), not scattered through the app.

Do not proceed to §6 until this passes.

## 6. Build and deploy

> **Superseded for day-to-day deploys:** use `scripts/deploy.ts` and `docs/deployment-runbook.md` (exact commit, only the flags that must change, before/after protection check, rollback). The commands below describe the original from-scratch setup and its flags (`--set-env-vars`, `--service-account`...) must NOT be passed to the existing sandbox service.

Simplest path — build and deploy from source in one command (uses Cloud Build):

```bash
gcloud run deploy hubi-pilot \
  --source . \
  --region=us-central1 \
  --service-account=hubi-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --no-allow-unauthenticated \
  --min-instances=1 \
  --memory=1Gi \
  --set-env-vars="HUBI_REASONING_PROVIDER=gemini,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_CLOUD_LOCATION=us-central1,HUBI_GEMINI_MODEL=gemini-2.5-flash,HUBI_CONTENT_SOURCE=gcs,HUBI_GCS_BUCKET=YOUR_BUCKET_NAME,HUBI_GCS_PREFIX=content-repository"
```

`--source .` uses the `Dockerfile` at the repo root (multi-stage: installs deps, runs `npm run build` for the Next.js standalone output, then a minimal runtime image with no Claude Code CLI and no Content Repository baked in).

### Access control — not public by default

`--no-allow-unauthenticated` above means the service requires an authenticated, IAM-authorized caller for every request — there is no public URL. This preserves the same "controlled access, not public" posture the local prototype has today (Architecture.md §17.1), extended to more than one machine.

Grant specific pilot testers access individually (exact list decided separately, per the product decision to defer that):

```bash
gcloud run services add-iam-policy-binding hubi-pilot \
  --region=us-central1 \
  --member="user:marina@wellhub.com" \
  --role="roles/run.invoker"
```

Repeat per tester. This is intentionally the simplest mechanism that satisfies "authenticated access only" — no IAP, no custom auth layer, matching the instruction not to introduce a complex enterprise auth layer unless the pilot actually requires it. If the tester list grows large or needs to change frequently without individual `gcloud` commands, revisit with Identity-Aware Proxy at that point — not before.

---

## 7. Rollback

Two distinct things can go wrong, with two distinct rollbacks:

- **A bad deploy (new revision misbehaves):** Cloud Run keeps prior revisions. Roll back traffic instantly without rebuilding:
  ```bash
  gcloud run services update-traffic hubi-pilot --region=us-central1 \
    --to-revisions=PREVIOUS_REVISION_NAME=100
  ```
- **Gemini itself is the problem (bad answers, outage, latency):** there is deliberately **no second cloud-compatible reasoning-engine fallback** to flip to at runtime — `reasoningEngine.claudeCode.ts` cannot run inside Cloud Run at all (it depends on an interactive `claude auth login` session that does not exist in a headless container; see §8). "Rollback" in this case means reverting to the previous Cloud Run revision if the previous revision didn't have this problem, or pausing the pilot and going back to local-machine testing with Claude Code while the Gemini issue is investigated. Do not read this section as "we can always fall back to Claude Code in production" — that path does not exist today.

---

## 8. Known limitations

- **`@google/genai` with Vertex AI is verified against live calls** (the pilot, the evals and the 2026-11-05 load test all run through `vertexai: true` with application default credentials). The earlier "unverified" caveat no longer applies.
- **Dependency advisories:** as of 2026-11-05 `npm audit --omit=dev` reports 0 vulnerabilities (Next.js 16.4.5; the earlier `uuid`/`gaxios` finding is gone). CI now fails on a high or critical advisory in production dependencies. Re-check periodically.
- **Cold-start download cost** (§4) — mitigated with `--min-instances=1`, not eliminated.
- **No incremental content sync** — every cold start re-downloads the full Content Repository from GCS. Fine at today's ~2GB pilot scale.
- **Conversation continuity does not depend on the instance:** the browser sends prior turns and the session is rebuilt from them (`lib/runtime/requestSession.ts`); the in-memory registry is only a fallback for older clients.
- **Governance, applicability, task planning and retrieval v2 now exist in code** (see `Implementation_Handoff.md`). This guide's migration notes predate them.
