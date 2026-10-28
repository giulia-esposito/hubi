# Pilot claim guardrail (verify-and-revise)

**Status: pilot mitigation, on by default for the stakeholder pilot. It is not the fix for claim fidelity (Finding #005), which stays open.**

Product decision (2026-10-29): enable it for the pilot as a guardrail, accept the extra latency in exchange for fewer unsupported figures and value claims, keep logging so triggers and revisions are visible, collect latency and experience feedback from testers, and keep treating scope and causality strengthening as an open gap.

## What it does

After the model answers a Business Assistance turn, the draft is checked against the chunks the model was given (`lib/runtime/claimVerifier.ts`):

- **Figures**: a percentage, multiplier or currency amount whose number appears in no retrieved chunk.
- **Value language**: ROI, productivity, retention, savings and similar business-value terms that appear in no retrieved chunk. Questions to the client ("How do you measure ROI?") are not claims and are not flagged.

If the check finds anything, **one** revision call asks the model to remove exactly those items (`lib/runtime/verifiedGeneration.ts`). The revision replaces the draft only if it has fewer violations and is not truncated; otherwise the original draft stands. A clean draft, and any turn the model does not report as business-assistance, costs no extra call.

## What it does not do (open gap)

It only catches content that has no support anywhere in the retrieved knowledge. It does **not** detect:

- a comparison restated as a cause ("users show lower costs than non-users" becoming "it leads to savings");
- a claim from one product or offer restated as a general claim;
- a dropped region, population or sample qualifier;
- a term the sources do use, restated with more strength than the source gives it.

In the measurements the count of causal-vocabulary sentences per answer was unchanged by the guardrail. These remain Finding #005 items, to be addressed by the generation-rule experiment and by Product review. Testers are asked to flag them ("Claim overstated (scope or cause)").

## Cost to the user: buffered delivery

A draft can only be checked once it is complete, so turns that may be artifact requests are **buffered**: nothing appears until the whole answer is ready (about 7-20 s), and the UI shows "Drafting and checking the answer against the sources". Other turns stream as before. A triggered revision adds about 6-9 s (max about 11 s in the measurements). Measured triggering: none or rare on short artifacts (a pitch, an email), common on long or tailored ones (a tailored pitch, a talk track).

## Setting

- On by default (`CLAIM_VERIFIER_PILOT_DEFAULT` in `lib/runtime/verifiedGeneration.ts`).
- `HUBI_VERIFY_CLAIMS=0` turns it off; `HUBI_VERIFY_CLAIMS=1` forces it on.

## What is logged (`logs/interactions.jsonl`)

Every turn that was buffered carries a `verification` object on its `interaction` record: `checked`, `violationsBefore`, `violationsAfter`, `revised`, `revisionAccepted`, `phrases` (what was flagged), `extraMs`, and, only when a revision was attempted, `draft` (the first draft, so a reviewer can see exactly what changed; the final text is the record's `response`).

Feedback records (`type: "feedback"`) carry `tags` (issue tags), `waitMs` (time from sending the question to the first visible text) and `buffered`, so the wait can be read against what the tester experienced. Issue tags: wrong region, claim not in the sources, claim overstated (scope or cause), wrong or missing source, too slow, other. "Helpful, but slow" is a one-click way to report latency on an answer the tester liked.

## Measurement evidence (Gemini 2.5 Flash, real corpus, 6 runs per arm per scenario)

Answers with unsupported figures or value language, baseline vs after the guardrail: tailored pitch 4/6 -> 1/6 (the remaining one was a run the model did not label business-assistance, so it was not verified); discovery talk track 4/6 -> 0/6 on the first run (inflated by a false positive on discovery questions, since fixed; baseline 0/6 and final 0/6 on the rerun); generic pitch, pitch to a prospect and intro email: 0-1/6 either way. Small samples, one provider and model. Reproduce with `npm run eval:verify-revise`.

## Known false-positive and coverage gaps

- A question followed by a parenthetical can still be treated as a claim.
- A creation verb in an operational question ("create an opportunity in Salesforce") buffers that turn although it can never be revised.
- If the model omits the planning-mode tag, the draft is not checked.
- A revision can swap a term for a synonym the sources do contain ("ROI" -> "measurable results") instead of removing the claim.
