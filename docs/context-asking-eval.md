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
