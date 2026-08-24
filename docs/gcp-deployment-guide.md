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

## 6. Build and deploy

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

- **`@google/genai`'s Vertex AI constructor option name is unverified against a live call.** `reasoningEngine.gemini.ts` uses `vertexai: true` (the long-established, still-current terminology in Vertex AI's own docs, and what `@google/genai@2.18.0` — the version pinned in `package.json` — is expected to accept). Some newer upstream documentation refers to a renamed `enterprise: true` option under a "Gemini Enterprise Agent Platform" banner; if that turns out to be what the installed version actually requires, this is a one-line fix in one file. This is exactly why the migration sequence has "test one isolated Gemini/Vertex AI call" as its own step before wiring the full adapter into the chat route — do that step first, and correct this file if needed before proceeding.
- **A new moderate-severity transitive vulnerability was introduced by this migration**, not present before it: `uuid <11.1.1` via `gaxios` (pulled in by Google's own auth library, itself a dependency of `@google/genai`/`@google-cloud/storage`). `npm audit fix` (including `--force`) has no available fix today — no newer `gaxios` release compatible with the current dependency tree exists yet. Confirmed via `npm audit` on `2026-08-24`; not blocking for a pilot, but worth re-checking with `npm audit` periodically until Google ships a fix upstream. The pre-existing `next`/`postcss`/`sharp`/`nanoid` advisories noted in `Implementation_Handoff.md` §6 were resolved as a side effect of this migration's `npm audit fix` run and no longer apply.
- **Cold-start download cost** (§4) — mitigated with `--min-instances=1`, not eliminated.
- **No incremental content sync** — every cold start re-downloads the full Content Repository from GCS. Fine at today's ~2GB pilot scale.
- **Session state is still in-memory per Cloud Run instance** (`lib/runtime/sessionRegistry.ts`, unchanged by this migration). Multiple instances do not share conversation state. This was already true and unaddressed locally (single process); Cloud Run's autoscaling makes it more likely to actually matter — a tester's conversation could land on a different instance mid-session under load. Not fixed here: this is a pre-existing, documented gap (`Implementation_Handoff.md` §6, "no session eviction... acceptable for short local test windows, not for sustained use"), and fixing it is a session-persistence project of its own, out of scope for this infrastructure migration.
- **No Task Planning, Retrieval V2, or Governance/Applicability layer exists in code** — confirmed by direct inspection before this migration began. `docs/milestone-retrieval-v2-taskplanning-v0-plan.md` describes a real, approved-in-principle plan for these, but zero code exists for any of it today, on either reasoning-engine path. The target-architecture pipeline mentioned when this migration was scoped (Task Planning V0 → Retrieval V2 → Governance/Applicability → Gemini) is the intended *future* shape; today, both the Claude Code and Gemini paths run against the same current pipeline: lexical BM25 retrieval → prompt builder → reasoning engine, nothing more.
