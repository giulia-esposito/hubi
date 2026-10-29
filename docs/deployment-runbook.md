# Deployment runbook

**Status:** the deployment foundation Hubi evolves from. It is meant to carry into production, not to be thrown away after the pilot. It encodes the operating model decided on 2026-10-16: GitHub is canonical, a deploy is an exact commit, and nothing that the sandbox owns is overridden.

## What exists

| Piece | Where | What it gives |
|---|---|---|
| CI | `.github/workflows/ci.yml` | Type check, tests and production build on every push and pull request to `develop` and `main`. No GCP credentials, deploys nothing. Verified by running the same steps on a clean copy with a fresh `npm ci` and no Content Repository. |
| Deploy script | `scripts/deploy.ts` (`npm run deploy:plan`, `deploy:status`, `deploy:verify`) | `plan`, `deploy`, `status`, `verify`, `rollback`. Pure rules in `scripts/lib/deployLogic.ts`, tested in `tests/deploy.test.ts`. |
| Environment config | `config/environments/pilot.json` | Project, region, service, the only `gcloud` flags a deploy may pass, and the branches a deploy may be cut from. A second environment is another file. |
| Build identity | `build-info.json` (written at deploy time, never committed), `lib/runtime/buildInfo.ts`, `GET /api/health`, a `startup` telemetry event, `commit` on every log entry | Which commit and revision are running, answerable from Cloud Logging. |

## The rules the script enforces

1. **A deploy is an exact commit**, on an allowed branch, with a clean working tree, exported with `git archive`. Never the working tree.
2. **It never runs without `--confirm <short commit>`**, typed with the commit it will ship.
3. **Only the configured flags are passed** (today `--memory 2Gi`). Flags that would override sandbox-managed settings (`--set-env-vars`, `--service-account`, ingress, VPC and network, labels, IAP, secrets, authentication) are rejected when the config is loaded.
4. **Protected settings are snapshotted before and compared after**: ingress, IAP, VPC interface and egress, service account, labels, every environment variable, resources and scaling. Any change the flags did not ask for is reported as an ALERT, with the rollback command, and the script exits non-zero.
5. **Tests, type check and build must pass** before anything is exported.
6. **Every deploy is recorded** in `logs/deploy-ledger.jsonl` (commit, branch, previous and new revision).

## Normal deploy

```bash
npm run deploy:plan          # read-only: preflight, checks, current service, the exact command
node --experimental-strip-types scripts/deploy.ts deploy --env pilot --confirm <short commit>
npm run deploy:verify        # confirms from Cloud Logging which commit started
```

`plan` and `deploy` need a clean tree on `develop` or `main`: commit first. Per the operating model, show the exact command and get approval before running `deploy`.

## Rollback

Cloud Run keeps prior revisions, so rollback is a traffic shift, not a rebuild:

```bash
node --experimental-strip-types scripts/deploy.ts rollback --env pilot            # shows the target, changes nothing
node --experimental-strip-types scripts/deploy.ts rollback --env pilot --to <revision> --confirm <revision>
npm run deploy:verify
```

By default the target is the newest revision older than the one serving. It refuses to roll back onto the revision that is already serving. A revision whose startup event shows the previous commit confirms the rollback.

## Verifying what is running

The service is behind IAP with internal ingress, so it cannot be reached from outside the network; verification uses telemetry instead:

- `deploy:verify` reads the latest `startup` events (`jsonPayload.event="startup"`), which carry `revision`, `commit`, `claimVerifierEnabled`, `provider` and the log target.
- Every `interaction` and `feedback` entry carries `commit` and `revision`, so a tester's feedback maps to an exact build.
- `GET /api/health` returns the same identity from inside the network.
- `build-info.json` reaches the build only because `.gcloudignore` exists: without it `gcloud run deploy --source` falls back to `.gitignore`, which excludes that file, and every startup event reports `commit: unknown` (found on the first deploy, 2026-10-29).
- Every `interaction` entry carries `callerKind` (`iap` when the proxy's user header was present, `anonymous` otherwise; never the user). After a deploy, one real request through IAP should log `iap`; `anonymous` means the request guard is sharing one bucket across everyone.

## Pilot environment

The pilot environment is `hubi-pilot` in `wh-revenue-sandbox` (min 1 and max 20 instances, 2 GiB, IAP, internal ingress). Cloud Run session affinity is off, which is why conversation context does not depend on the instance (docs/session-architecture.md). A staging service alongside it is a decision for you (below).

## Decisions that need approval before anything changes

These are outward-facing or long-term and are deliberately not done:

1. **Running the first deploy.** The live revision (`hubi-pilot-00005-s6p`) was built from `bb23f3c` and predates everything since. Nothing has been deployed or pushed.
2. **A staging environment** (a second Cloud Run service, or a separate project). It would be created under sandbox-managed ingress, IAP and networking, so it needs the owners' input. The config format already supports it.
3. **Automatic deploys from GitHub (Cloud Build trigger or GitHub Actions with Workload Identity Federation).** Paused by decision on 2026-10-16. CI here only verifies. Moving to automatic deploys changes who can reach production and needs IAM changes in the sandbox project.
4. **Repository ownership.** The GitHub repository is under a personal account, not the Wellhub organization; it should move before production.
5. **Corporate Production.** The service is in a Sandbox project. Promotion follows the organization's own process (see the production plan, priority 8).

## Build notes learned while building this

- A dynamic file read in `lib/applicability/regions.ts` (the optional local region override) made the bundler trace the entire project into the standalone output: 4.4 GB locally. It is now marked ignorable and the output is about 23 MB. Keep dynamic filesystem paths out of server code, or mark them `/*turbopackIgnore: true*/`.
- Tests that need the real Content Repository (gitignored, about 2 GB, lives in GCS) skip with a reason when it is absent, so CI is meaningful without it. Locally nothing is skipped.
