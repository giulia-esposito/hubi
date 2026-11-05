# Model lifecycle: pinning, upgrading and rolling back (audit item P2-7)

## Where the model is set

| Place | Value | Notes |
|---|---|---|
| Code default | `gemini-2.5-flash` (`lib/runtime/reasoningEngine.gemini.ts`) | used when the variable is unset |
| Deployed pilot | `HUBI_GEMINI_MODEL=gemini-2.5-flash` | read on 2026-11-05; an environment variable of the Cloud Run service, which is **sandbox-managed configuration**: changing it is a deliberate, reviewed change, not part of a normal deploy (`scripts/deploy.ts` never passes env vars) |
| Evidence of what runs | the `startup` log event carries `model` and the generation parameters; `deploy.ts verify` prints the serving commit | so "which model answered" is always answerable from Cloud Logging |

`gemini-2.5-flash` is a stable alias: Google can move it to a newer patch without a redeploy, which changes answer behavior silently. A versioned model id (for example one with an explicit version suffix, if Vertex lists one for this model) fixes the behavior until you choose to move.

## Recommendation

1. **Pin a versioned id before leaving the pilot**, if Vertex offers one for the model in use. Check the list in the Vertex AI model garden for the exact id (do not guess it from memory) and put it in the service's `HUBI_GEMINI_MODEL`.
2. **Record the retirement date** of the pinned model from the Vertex model-versions page in this file when you pin it (it is not recorded here because it was not verified in this review): `Retires: <date, source link>`. Add a calendar reminder 90 days before it.
3. **Never move the alias and the code together.** A model change is its own release: nothing else ships with it, so any behavior difference is attributable.

## Upgrade procedure (a new model version, or a move off an alias)

1. **Candidate, locally, no deploy:** run the evals with the candidate against the same corpus and compare with the baseline in `evals-out/`:

   ```bash
   HUBI_GEMINI_MODEL=<candidate> HUBI_REASONING_PROVIDER=gemini GOOGLE_CLOUD_PROJECT=wh-revenue-sandbox EVAL_RUNS=5 \
     node --experimental-strip-types scripts/eval-applicability.ts
   ```

   Repeat for `eval-context-asking`, `eval-claim-fidelity`, `eval-safety` and `validate-pilot`. Cost is small (about $0.03 to $0.2 per suite).
2. **Gate:** no scenario family may drop against the baseline by more than the run-to-run noise (use 5 runs per scenario; single-run differences of one scenario are noise), the safety eval must stay at 100%, and median and p95 latency from `scripts/load-test.ts` must stay within the load-test report's range (`docs/load-test-2026-11-05.md`). Thinking-token usage can change cost: compare the `[usage]` line (`HUBI_USAGE_REPORT=1`).
3. **Generation parameters:** a new model may treat temperature, `maxOutputTokens` and thinking differently. Re-check `generationConfig` (`DEFAULT_*` constants, `HUBI_GEMINI_*` overrides) against the model's documentation before comparing.
4. **Change the service variable** through the approved path for sandbox-managed config (not a flag on `deploy.ts`), then `deploy.ts verify` and read the `startup` event to confirm the new `model` value.
5. **Watch** the log metrics (`docs/monitoring.md`) and a handful of real questions for the first day.

## Rollback

Cloud Run keeps previous revisions, and a revision carries its own environment: rolling back the revision rolls the model back with it.

```bash
node --experimental-strip-types scripts/deploy.ts rollback --env pilot --to <previous revision> --confirm <previous revision>
```

If only the model variable changed on a revision, rolling back to the revision before that change restores the old model without touching code.

## Retirement

When a model reaches its retirement date, calls start failing with a not-found or permission style error, which the resilience layer treats as permanent (no retry) and the `hubi_interaction_errors` metric counts. Treat the retirement date as a hard deadline for the upgrade procedure above, not a surprise.
