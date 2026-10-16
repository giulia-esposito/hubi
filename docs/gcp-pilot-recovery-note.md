# GCP Pilot Recovery Note (2026-10-16)

Status: **recovered and validated.** The `hubi-pilot` Cloud Run service answers real queries again. This note records what broke, what was fixed, and what is still open. The open items are product-quality issues, not infrastructure.

## Root cause

On the first real query the service never returned an answer (the UI stayed on "..."). The container was OOM-killed (signal 9) and restarted in a loop, and `/api/chat` returned 503.

- In `gcs` content mode, `lib/ingestion/contentSource.ts` downloaded **every** object under the bucket prefix into the container's temp directory, which is memory-backed on Cloud Run. The bucket holds 191 objects: 74 ingestible `.docx`/`.pptx` files (264.9 MiB) and 117 media or other files (about 11.4 GiB of `.mp4`, `.jpg`, `.png`, `.avif`).
- Each object was read with `file.download()`, which buffers the whole object in a Node `Buffer` before writing it. This behavior pre-dated the filter work.
- The `PMM _ Slide Library _ US _ DO NOT EDIT.pptx` (191.4 MiB) could not be buffered inside the 512Mi limit. Logs showed the "large file" warning, then `Out-of-memory event detected`, then `Container terminated on signal 9`, twice in a row.

## Fixes applied

| Commit | Change |
|---|---|
| `7161f77` | Content-source allowlist: only `.docx` and `.pptx` are downloaded. Media, images, ZIPs and other formats are skipped before download. The shared allowlist lives in `lib/ingestion/supportedFormats.ts`. PPTX support, including the Slide Library, is preserved. |
| `bb23f3c` | Downloads are streamed to disk (`createReadStream()` piped to `createWriteStream()`) instead of buffered. Streams are opened only for files that pass the allowlist. A `[contentSource] Plan:` log line is written **before** any download starts (selected count and bytes, large files, skipped unsupported and oversized). |

Both commits are on `main` and `develop`, which are in sync at `bb23f3c`. Tests: 31 of 31 pass, the type check is clean, and the production build passes.

Memory was raised from 512Mi to 2Gi on the Cloud Run service. Observed steady state after the fix is about 37% of 2Gi (roughly 760 MiB), so the old 512Mi limit would not have been enough even with streaming.

## Final runtime configuration

Service `hubi-pilot`, project `wh-revenue-sandbox`, region `us-central1`, revision `hubi-pilot-00005-s6p` (image built from commit `bb23f3c`), 100% of traffic.

- Memory 2Gi, 1 vCPU, min instances 1, max instances 20.
- Runtime service account `sandbox-run@wh-revenue-sandbox.iam.gserviceaccount.com`.
- Ingress `internal`, IAP enabled, VPC network interface `develop-iac-management` / `dev-workload-subnet`, egress `all-traffic`.
- Environment variables (unchanged): `HUBI_REASONING_PROVIDER=gemini`, `HUBI_GEMINI_MODEL=gemini-2.5-flash`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=us-central1`, `HUBI_CONTENT_SOURCE=gcs`, `HUBI_GCS_BUCKET`, `HUBI_GCS_PREFIX=content-repository`.
- Labels and sandbox-managed settings are unchanged. Only the image digest and memory changed between revisions 00004 and 00005.

Deployment path: direct `gcloud run deploy hubi-pilot --source <export of the exact commit> --memory 2Gi`, run with the owner's authenticated `gcloud`. No other config flags are passed, so everything else carries over. GitHub-triggered CI/CD is paused. The previous revision `hubi-pilot-00004-kbn` still has 512Mi and the old download code, so it is not a useful rollback target.

## Validation results (revision `hubi-pilot-00005-s6p`)

- Plan line: 74 supported files selected (264.9 MiB); 1 large file (Slide Library, 191.4 MiB); 117 unsupported files skipped (11,663.0 MiB); 0 oversized.
- All 74 downloads completed (`Downloaded 74 files (264.9 MiB)`, about 8.4s). The Slide Library completed.
- Three `POST /api/chat` requests returned 200: 12.9s (cold start, includes the download), 5.7s and 4.8s.
- No OOM events, no signal 9, no restarts after the deploy. Memory utilization held at 37% of 2Gi.
- Ingestion completion and Gemini success are inferred from the 200 responses and latencies. The app does not currently log chunk counts or Gemini calls.

## Known remaining issues (not infrastructure)

1. **Answer-quality regression on Business Assistance / elevator-pitch queries.** Needs product review. It will be handled with the Retrieval V2 / Task Planning V0 work (see `docs/milestone-retrieval-v2-taskplanning-v0-plan.md`).
2. **Cold-start ingestion cost.** Every cold start re-downloads and re-ingests about 265 MiB. The first request after a cold start took about 13s. With min instances at 1 this is rare, but it recurs on every deploy and restart.
3. **`MaxListenersExceededWarning` noise.** About 150 warnings about `PassThrough` listeners appear in the logs during the content download. They are harmless but not yet explained.

## Small follow-ups worth considering

- Log document and chunk counts at the end of ingestion, and log Gemini request outcomes, so future validation does not rely on inference.
- Revisit the CI/CD decision once the pilot is stable, so that the deployed commit is traceable without relying on a manual process.
