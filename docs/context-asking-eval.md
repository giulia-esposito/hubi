# Context-asking eval: baseline (2026-10-29)

Does Hubi ask for context (tier, segment, role, region) only when it changes the answer? Script: `scripts/eval-context-asking.ts` (live model, real corpus, 22 scenarios, 3 runs each, Gemini 2.5 Flash). Raw first run: `benchmarks/applicability/baseline-2026-10-29.json`. **Nothing has been strengthened and no content has been relabelled: this is the baseline from which the V1 pass bar is to be set.**

## How to read the numbers

- *Must ask*: the answer differs by the dimension and the user did not say which. **Success** is asking, or answering for every variant. **Silent pick** (answering for one value without saying so) is the harmful failure. **Dead end** (a non-answer where a question was needed) is the other.
- *Must not ask*: the answer does not depend on context. Asking is the failure (friction).
- *Pre-supplied*: the context is in the question. Asking again is the failure.
- *Follow-through*: Hubi asks, the user answers, Hubi must then answer.

Two harness problems found while reading the results were fixed (measurement only, no product change): the eval path did not run the cross-language query expansion the web route runs, and it scored a short direct answer (under 400 characters) as "thin". The corrected figures replace the first run for the two scenarios affected (`ask-tier-onboarding`, `follow-tier-service-level`); every other number is the first run's.

## Result

| Measure | Result |
|---|---|
| **Ask-when-needed** (asks, or answers for every variant) | **15 of 21 (71%)** |
| of which asked outright | 4 of 21 (all of region, plus 1 of 3 onboarding runs) |
| of which answered for every variant | 11 of 21 |
| **Over-ask** (asked where context was not needed) | **0 of 24 (0%)**; also 0 of 12 re-asks when context was already given |
| Follow-through (answers once context is given) | 9 of 9 (100%) |

| Dimension (must-ask) | Success | Silent pick | Note |
|---|---|---|---|
| Region | 3 of 3 (100%) | 0 | The deterministic region gate asked every time |
| Tier | 7 of 9 (78%) | 0 | Service level and contract differences: answered for every tier. Onboarding steps: see failure 1 |
| Segment | 5 of 6 (83%) | 0 | PPS+ proposal: 1 of 3 answered generically; see failure 3 |
| Role | **0 of 3 (0%)** | **2 of 3** | See failure 2 |
| Stage | not measured | | The local corpus has no documents that differ by stage for the same question |

## Failed scenarios

| # | Scenario | Result | Cause | Smallest recommended fix |
|---|---|---|---|---|
| 1 | `ask-tier-onboarding`: "What are the steps of the client onboarding process?" | 1 of 3 asked; 2 of 3 a **dead end** ("the retrieved knowledge does not describe the steps") | **Retrieval ranking plus applicability window.** The query expansion fires and the Spanish SS Latam onboarding document (RKC-000006) is in the 15 raw results, but ranks below generic Global and unspecified chunks that merely mention onboarding, so the five sources the model sees contain no onboarding process and the region gate has nothing region-specific in its window to react to | Compute the "region-specific material exists but is withheld" signal over the whole over-fetched list (15), not only the top 5, so the existing "ask the region if the answer depends on it" notice fires. One-line window change in the applicability layer, plus an eval re-run |
| 2 | `ask-role-coaching`: "How should I run a Work the Deal coaching session?" | 0 of 3: 2 silent blends, 1 generic | **Applicability logic gap, enabled by model judgment.** Retrieval is correct (the Sales coaching session RKC-000016 and the Customer Success coaching session RKC-000015 are both retrieved) and the metadata is present (Audience: Sales versus CS), but there is no audience dimension: the model merges two role-specific guides into one set of instructions | When two or more retrieved documents carry audience labels that share nothing and the user has not stated a role, add one prompt notice listing the audiences and telling the model to ask one short question or answer each audience separately. Deterministic, from the sources' own labels, no model call |
| 3 | `ask-segment-pps`: "What does the PPS+ proposal look like for my client?" | 2 of 3 answered for Enterprise and SMB; 1 of 3 answered generically without naming either | **Model judgment, with missing metadata.** The PPS+ Enterprise and SMB slides sit in the Slide Library, which has no audience labels, so nothing deterministic can tell the model the sources are segment-specific. Whether a generic answer is materially wrong is a Product call | None until Product decides whether this is material. If it is: label the Slide Library's segment slides (Content), which would let the same audience notice cover it |

## What the baseline says in product terms

- **Over-asking is not a problem**: 0 of 24, and Hubi did not re-ask when the context was in the question.
- **Hubi mostly covers variants instead of asking.** Outside region, it asked outright in only 1 of 18 runs; for tier and segment it answered for each value. That fits "ask only when it materially changes the answer" and gave no silent picks for tier or segment. It would be wrong if a variant answer is too long or confusing for users; that is a quality question for the pilot, not measured here.
- **The two real gaps are different in kind.** Failure 2 is a wrong answer (two roles blended). Failure 1 is a missing answer (a dead end), and it comes from retrieval and the region window, not from the model.
- **Scenario coverage is thin**: 7 must-ask scenarios, 8 must-not-ask, 4 pre-supplied, 3 follow-through, 3 runs each. A "covers every variant" success is detected by a pattern that counts two named values, so it can overcount.
- **The unlabelled files matter**: about 71 percent of the chunks come from five files with no audience, region or tier labels. Failure 3, and any future segment or tier case in them, cannot be made deterministic until Content labels them.

## Decision for Product

Set the V1 pass bar from these numbers. The questions that decide it: is a silent pick of one role acceptable for a controlled audience (failure 2), is a dead end on onboarding acceptable (failure 1), and does a generic PPS+ answer count as a failure (failure 3).

## After fixes 1 and 2 (same day, same scenarios, 3 runs each)

Product asked for fixes 1 and 2 only. Full re-run (`benchmarks/applicability/after-fixes-2026-10-29.json`, taken with both fixes in place):

| Measure | Baseline | After |
|---|---|---|
| Ask-when-needed | 15 of 21 (71%) | 18 of 21 (86%) |
| Over-ask | 0 of 24 | 0 of 24 |
| Re-asked when context was given | 0 of 12 | 0 of 12 |
| Follow-through | 9 of 9 | 9 of 9 |
| Role | 0 of 3 | **3 of 3** (both audiences answered, labelled; no blending) |
| Segment | 5 of 6 | 6 of 6 (see below: not caused by a fix) |
| Tier | 7 of 9 | 6 of 9 (onboarding 0 of 3; run-to-run variation on a scenario that was 1 of 3) |
| Region | 3 of 3 | 3 of 3 |

**Fix 2 (audience notice) worked and is kept.** When the retrieved documents carry audience labels that share nothing and the user has not named one, the prompt now says so and tells the model to ask one short question or answer each audience separately, labelled. The role scenario went from two silent blends to three labelled per-audience answers, with no change to over-ask or to any other scenario. Code: `lib/applicability/audience.ts`, a notice in `lib/runtime/promptBuilder.ts`, logged as `applicability.audienceConflict`; tests in `tests/contextApplicability.test.ts`.

**Fix 1 (widen the region-notice window) did not fix its scenario and was reverted.** It worked mechanically: the withheld SS Latam onboarding document, at rank 14, now produced a region notice in every run. But the notice is optional by design ("if the answer depends on region, ask; otherwise answer from the sources"), and the model chose to answer from generic sources about reseller onboarding and migration instead, so `ask-tier-onboarding` stayed at 0 of 3 with the fix on. Shipping a prompt change with no measured benefit adds a notice to many unrelated questions, so I removed it. A spot re-run after the revert (role 3 of 3, onboarding 0 of 3, two no-ask scenarios and one context-given scenario all 3 of 3) confirms the final state.

**The segment improvement is not credited to a fix.** The PPS+ proposal scenario answered for both segments in all 3 runs this time, where one run answered generically before. Its sources are the unlabelled Slide Library, so neither fix touches it: treat it as run-to-run variation.

### What remains, and the options

`ask-tier-onboarding` is still a dead end: with no region stated, Hubi sees generic sources and says the knowledge does not describe a general onboarding process. The missing piece is a *decision* rule, not more retrieval: the only strongly relevant source is region-specific and withheld, and a soft notice is not enough. Options, from smallest:
1. **Escalate to a question** when a region-specific source scores close to the best match, sits within the 15 retrieved, and the top sources do not match the question's own key terms (a stricter, deterministic variant of fix 1). Risk: asks about region more often; needs the must-not-ask scenarios re-run.
2. **Let the model decide with a stronger instruction** in the existing notice ("if none of the sources above answers the question and region-specific material was withheld, ask for the region instead of saying nothing is available"). Cheaper, but it relies on model judgment, which just ignored the soft version.
3. **Label the process documents** so the generic Sales Tools Playbook is not the best match for "client onboarding": a Content task, not code.

## After the strong-regional-match rule (same day; full re-run, 3 runs per scenario)

Product asked for the smallest deterministic change that turns the onboarding dead end into a region question. The rule (`applyApplicability`, option `strongRegionalRatio`, constant `STRONG_REGIONAL_RATIO = 0.7` in `lib/runtime/retrieveApplicable.ts`): when the user's region is unknown and any region-specific chunk among the 15 retrieved scores at least 70 percent of the best chunk, the turn is gated and Hubi asks which region applies, naming the region of the withheld material. It uses the existing must-clarify path (no content is sent to the model; one short question in the user's language) with accurate wording ("the best approved material for this question is specific to SS Latam"). It is logged as `applicability.clarifyReason`. Once the region is stated, the regional source is eligible and the answer follows. Full results: `benchmarks/applicability/after-strong-regional-2026-10-29.json`.

| Measure | Baseline | After audience notice | **After this rule** |
|---|---|---|---|
| Ask-when-needed | 15 of 21 (71%) | 18 of 21 (86%) | **21 of 21 (100%)** |
| **Over-ask** | 0 of 24 | 0 of 24 | **0 of 24 (0%)** |
| Re-asked when context was given | 0 of 12 | 0 of 12 | 0 of 12 |
| Follow-through | 9 of 9 | 9 of 9 | 8 of 9 (see below) |
| Tier | 7 of 9 | 6 of 9 | 9 of 9 |
| Segment | 5 of 6 | 6 of 6 | 6 of 6 |
| Role | 0 of 3 | 3 of 3 | 3 of 3 |
| Region | 3 of 3 | 3 of 3 | 3 of 3 |

`ask-tier-onboarding` now asks for the region in 3 of 3 runs, and once the user says "Tier 1 in Mexico" the SS Latam onboarding process answers (5 of 5 in a separate check).

**How narrow the rule is, measured before the eval.** Over 64 known questions (the 45 retrieval-benchmark questions with their region context and recorded expansions, plus the eval's general and context-supplied questions) it fires on exactly two: the onboarding question and the vague "contract differences" question. It fires on none of the general-knowledge questions and none where the region or other context was already given. A test pins this (`tests/contextApplicability.test.ts`), so a later change that makes it fire more widely fails the suite.

**Side effect to be aware of.** The second question it fires on, "What are the contract differences I need to know for my client?", used to be answered across all tiers from the Global contract-adherence document. It now asks the region first, because US and SS Latam material is a close match. That counts as an acceptable outcome in the eval (it is a tier-dependent question), but it is a behaviour change and arguably an extra step for a question a Global source could answer. The ratio is one constant; raising it to 0.75 turns the rule off on both known cases, so it cannot be tuned finer on this corpus. If Product prefers the old behaviour for that question, the lever is the labelling of the contract document, not the ratio.

**One follow-through run was thin.** In the onboarding follow-through scenario, 1 of 3 runs produced a second answer that was too short to count as answering. A separate 5-run check of the same conversation answered substantively every time (5 of 5), so this is most likely run-to-run variation, but it is not proven; one more look is worth taking if it recurs in the pilot.

**Limits.** The ratio was calibrated on one example plus a guard set; 0.7 is not a derived constant. It relies on BM25 scores, which shift if the corpus, chunking or tokenisation changes: the retrieval benchmark and the pinned test are the early warning. The two known firing cases are still only 2 of 64 questions, so the real firing rate on pilot traffic is unknown. Switch it off by removing `strongRegionalRatio` from the call in `retrieveApplicable`.

## Re-measured on the production corpus (2026-10-29, after the first pilot test)

The first real pilot question ("What are the steps of the client onboarding process?") got a dead end although the eval had been green. Cause: **the evals ran on a 20-document local export (2026-07-21); the pilot serves a 74-document Cloud Storage export (2026-08-24)**, with newsletters, town halls and wiki pages the local copy lacks, and without the Sales Tools Playbook, the Golden Pitch deck and RKC-000027. From now on evaluate on the deployed corpus:

```bash
node --experimental-strip-types scripts/fetch-prod-corpus.ts            # copies the pilot's .docx and .pptx files to "Content Repository (prod)" (gitignored)
HUBI_CONTENT_REPOSITORY_PATH="Content Repository (prod)" npm run eval:context-asking
HUBI_CONTENT_REPOSITORY_PATH="Content Repository (prod)" npm run eval:retrieval -- --expand
```

(The retrieval benchmark leaves out gold questions whose answer passage is not in the corpus: 11 of 46 on the production corpus, listed in its output.)

### What the production corpus showed, and the three changes made

1. **The query expansion could not surface the right document.** The real answer (the Spanish SS Latam onboarding training) scored 21 for the expansion against 12 for the English query, but rank fusion ignores scores and the expansion carried a lower weight for a merely weak English match, so every expansion-only chunk stayed below all 15 original results. Fix: when the expansion's best score is at least 1.5 times the original's, fuse at equal weight (`DOMINANT_EXPANSION_RATIO`); Spanish and Portuguese function words the model keeps in its terms ("qué es") are stripped first, because they match Spanish documents on grammar alone and looked like dominance.
2. **The strong-regional rule needed a title check once expansion results could enter the list.** Cross-language scores are not comparable with the question's own, so a Spanish document that merely matched translated filler words turned two general questions (a pitch question and "What is the Wellhubverse?") into region questions in a guard test. The rule now also requires the regional document's *title* to share a term with the question ("Onboarding" in "[SSL] Proceso de Onboarding Tiers 0, 1 y 2"). Side effect: the vague contract-differences question no longer asks the region (no title match); it answers across tiers again.
3. **After the user gave the region, the answer was still a dead end.** "Tier 1 in Mexico" scored the English query high enough (14.6, from the newsletter) that the expansion did not run, so the SS Latam material never reached the top five: Hubi asked for the region and then failed. Fix: once a region is known, the best two chunks written for that region from a deeper search (150 chunks, at least half the best score) are added. No model call.

### Result on the production corpus (22 scenarios, 3 runs each)

| Measure | Result |
|---|---|
| **Over-ask** | **0 of 24**; 0 of 12 re-asks when the context was given |
| Onboarding question | asks for the region 3 of 3 (was a dead end); after "Tier 1 in Mexico" it answers 3 of 3 |
| Follow-through | 9 of 9 |
| Tier / Region | 9 of 9 / 3 of 3 |
| Segment | 5 of 6 (one generic PPS+ answer) |
| Role | 0 of 3 as scored: see below |
| Ask-when-needed overall | 17 of 21 (81%) |

**The role result needs interpretation.** The audience-conflict detector fires 3 of 3 and the notice is in the prompt ("Sales (Source 1) versus CS (Source 2)"), but the model answers once, from one guide. In the production corpus the Sales and Customer Success coaching documents open with the same text (a shared "Field Agent Debrief" template; only 33 percent of their vocabulary overlaps, mostly in the session transcripts), and the notice says to answer normally when the answer is the same for every audience. So this may be correct behaviour that the scenario's scoring cannot recognise; it is not proven. A scenario built on documents that truly differ by role would settle it.

### Retrieval benchmark (35 answerable gold questions on the production corpus)

Raw Recall@5 with the cross-language expansion went from 86 to 89 percent and MRR from 0.719 to 0.721; one paraphrase question (`pitch-structure`) that used to sit at rank 13 now falls outside the top 15 because the dominant expansion pushed it out. The onboarding question moved from rank 15 to rank 2. The committed local baseline was regenerated (46 questions).

### Not fixed, and found along the way

- **Newsletters outrank real content.** The "Trending This Week" pages (RKC-000041 and others, Eligible with Restrictions, "always prefer the original source") rank first on topic words for questions about trainings they merely announce. Options: a ranking penalty for chunks carrying that restriction, or Content marks them Not Eligible.
- **Managers-only documents are in the deployed corpus** (RKC-000001 "MANAGERS ONLY", RKC-000017 "Managers huddle"; the registry says Eligible). The "corpus is the access boundary" decision assumed none were; the cheap fix is to remove them from the bucket.
- **The content is mostly trainings, not process documents.** Retrieval can now reach the steps inside a training, but a question about "the process" will often be answered from what a training says about it.

## Production-corpus follow-up on the two must-ask misses (2026-10-30)

Run on the deployed corpus after the source-governance work (3 runs per scenario): over-ask 0/24, re-ask 0/12, follow-through 9/9, must-ask 18/21. The two misses were inspected source by source and answer by answer.

**`ask-role-coaching` (1 of 3): evaluation-design issue, not a product failure.** On the production corpus the Sales coaching session (RKC-000016) and the CS coaching session (RKC-000015) carry the same description ("Field Agent Debriefs... 30-minute, high-energy coaching sessions... role-plays and mission-critical homework") and are recordings of the same coach teaching the same discovery-call method; they differ in who role-played and in the examples. The Sales and CS labels describe the participants, not different instructions. "How should I run a Work the Deal coaching session?" therefore has one answer for both, and the model gave it (one run said so explicitly: the structure and method are the same, only the examples differ). The scenario only counted as a miss because the judge treats any single mention of "sales" (for example "sales technique") as a silent pick of one role. The scenario was a real test on the local export, where the two documents differ; on the production corpus it no longer discriminates, so it is excluded from the production pass bar. It needs a replacement: a question where Sales and CS guidance genuinely differ in production, to be found with Content. The audience notice still fires here (labels share nothing) and is harmless: the answers were correct either way.

**`ask-segment-pps` (5 of 6): model variability on an ambiguous question; no material misleading.** The retrieved sources are the unregistered PMM slide library and the pricing playbook (no type, date or audience labels, so none of the four governance steps touched this answer). Six extra runs showed the real instability: 3 of 6 answered with what PPS+ is and how it is presented, 3 of 6 said no PPS+ *proposal document* exists in the knowledge (true: the slides are marked internal, not for presentations). Where a segment was named it was as a labelled condition ("for Enterprise clients, there is an optional upgrade path to flat-fee"), not an assumption that the client is Enterprise, so the judge's "answered-one" is a false positive on conditional wording. The user-facing risk is inconsistency between an answer and a "not documented" reply to the same question, not a wrong segment.

No application change is justified by either miss, so no scenario was re-run after a change. Open items: replace the role scenario; watch in the pilot for "no-grounded-answer" on questions phrased as "what does X look like" where the corpus describes X but holds no template of it.
