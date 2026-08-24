# Hubi — Reasoning Engine Migration Validation Checklist

**Purpose:** confirm that swapping the reasoning engine from Claude Code to Gemini (via Vertex AI) introduces no *regression* — same retrieval, same grounding discipline, same citation behavior — while accepting that the two models will not phrase answers identically. This checklist operationalizes migration sequence steps 9–14 (`docs/gcp-deployment-guide.md` is the deploy mechanics; this is the go/no-go judgment).

**Out of scope for this checklist:** anything about Task Planning, Retrieval V2, or Governance/Applicability — none of that exists in code on either reasoning-engine path today (see `docs/gcp-deployment-guide.md` §8). This checklist only judges the reasoning-engine swap itself.

---

## How to run each scenario against both providers

```bash
# Claude Code (today's default -- requires `claude auth login` on this machine)
npm run ask -- "<scenario question>"

# Gemini via Vertex AI (requires GOOGLE_CLOUD_PROJECT set and `gcloud auth
# application-default login` run locally first, or run from a Cloud Run
# instance where the service identity provides this automatically)
HUBI_REASONING_PROVIDER=gemini npm run ask -- "<scenario question>"
```

Multi-turn scenarios: start `npm run ask` with no argument for the interactive REPL (same provider selection applies), and enter each turn in sequence.

For each scenario, record the five judgment columns below. **Retrieval quality**, **Task Planning output** (today: always N/A — no such component exists), and **grounding** should be identical or near-identical between providers, because retrieval and prompt construction are provider-independent (`lib/retrieval/index.ts`, `lib/runtime/promptBuilder.ts` run unmodified regardless of `HUBI_REASONING_PROVIDER`). A difference in *those* columns points at something wrong in the migration, not an expected model-personality difference. **Final response quality** and **model-specific behavior** are where an honest difference in phrasing/tone/verbosity is expected and fine — the judgment there is "still meets the bar," not "identical."

---

## Scenario checklist

| # | Scenario | Retrieval quality (Claude vs. Gemini) | Task Planning output | Grounding (citations accurate, no invented facts) | Final response quality | Model-specific behavior notes | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | Enterprise onboarding / Mexico | | N/A (not implemented) | | | | ☐ Pass ☐ Regression |
| 2 | MX equivalent | | N/A | | | | ☐ Pass ☐ Regression |
| 3 | Spanish-language equivalent | | N/A | | | | ☐ Pass ☐ Regression |
| 4 | Portuguese-language equivalent | | N/A | | | | ☐ Pass ☐ Regression |
| 5 | Financial Services elevator pitch | | N/A | | | | ☐ Pass ☐ Regression |
| 6 | Burnout-tailoring continuation (multi-turn) | | N/A | | | | ☐ Pass ☐ Regression |
| 7 | Factual pricing/policy question | | N/A | | | | ☐ Pass ☐ Regression |
| 8 | Safe no-grounded-answer (fabricated/off-corpus query) | | N/A | | | | ☐ Pass ☐ Regression |
| 9 | Regional applicability (known gap, Findings #001/#002 — expected to fail the same way on both providers) | | N/A | | | | ☐ Pass ☐ Regression |
| 10 | Business Assistance | | N/A | | | | ☐ Pass ☐ Regression |
| 11 | Source attribution accuracy | | N/A | | | | ☐ Pass ☐ Regression |

**Verdict definitions:**
- **Pass** — retrieval and grounding match Claude Code's behavior for this scenario; any response-quality/tone differences are acceptable model-personality variation, not a functional regression.
- **Regression** — something that worked correctly on Claude Code breaks, degrades, or becomes ungrounded on Gemini. Record specifics in the notes column; do not proceed to Cloud Run deployment with an open Regression verdict.

---

## Specific things to watch for, given what actually changed

- **The trailing `[[HUBI:...]]` self-report tag** (`lib/runtime/promptBuilder.ts` / `lib/runtime/turnKind.ts`) is a plain instruction in the shared, provider-agnostic system prompt — it is not Claude-specific, but it has only ever been validated against Claude Code's compliance with formatting instructions. Confirm Gemini reliably produces the tag in the exact `[[HUBI:KEYWORD]]` format on the final line; if it doesn't, `turnKind` silently degrades to `"unknown"` (safe by design — the UI's neutral fallback — but worth knowing about rather than discovering by accident).
- **Streaming shape.** Both adapters expose the same `onDelta` callback contract, but the *granularity* of chunks (character-by-character vs. word/sentence-level) may differ between Claude Code's stream-json events and Gemini's `generateContentStream` chunks. Confirm the UI's tag-holdback buffer (`HOLDBACK_CHARS` in `turnKind.ts`) is still large enough to never leak a partial tag if Gemini emits larger chunks than Claude Code did.
- **Refusal discipline.** Scenario 8 (safe no-grounded-answer) is the most important single scenario in this table — it's the one Architecture.md §19 treats as non-negotiable ("Hubi must not compensate for technical or content failures by inventing an answer"). If Gemini is measurably more willing to hedge-and-guess than Claude Code was on the exact same retrieved context, that is a Regression, not a style difference.
- **Latency.** Not a pass/fail column above, but worth recording informally: Prototype_Plan.md's Claude Code baseline was ~8s full-response / ~1.5-2.2s time-to-first-token. Note whether Gemini is meaningfully slower or faster, since that affects the `--min-instances`/timeout choices in the deployment guide.

---

## Sign-off

- [ ] All 11 scenarios run against both providers, table filled in.
- [ ] No open "Regression" verdicts, or every open one has an explicit owner and decision (accept for pilot / block until fixed).
- [ ] Latency observations recorded.
- [ ] Findings shared with Product before Cloud Run deployment (step 13 in the migration sequence) proceeds.
