# Fixes from the first pilot conversations (2026-10-30)

Three real conversations exposed answer-quality gaps that the earlier evals did not cover. The diagnosis, the four fixes and the measurements live here. Regression suite: `scripts/eval-pilot-conversations.ts` (live model, production corpus, `HUBI_CONTENT_REPOSITORY_PATH="Content Repository (prod)"`).

## Diagnosis

| Conversation | Category | Cause |
|---|---|---|
| Onboarding steps, then "Mexico" | Retrieval failure | The SS Latam onboarding training has an overview of the whole flow, but a one-word reply made retrieval lose the question's words and the cross-language terms. The region pass then added two weak chunks of that document. |
| Onboarding steps, then "US" | Content gap | Only the newsletter announcing the US onboarding training is in the corpus, not the training. |
| "How can I explain Wellhub to a client?" | Weak retrieval, then synthesis | No source is about explaining Wellhub (best match about 7); the model assembled region-, tier- and segment-specific guidance as general guidance. |
| "Qual contrato devo usar?", then "Brasil" | Contextual applicability | Region was asked; the sales channel (direct or partner) was silently assumed. The direct-sales contract training was not retrieved. |

## Fix 1: search context across short turns (built)

The search is the question that opened the topic plus the replies after it; a new unrelated question starts a new topic; the cross-language check reads the question and judges its lexical match on the question alone; the region pass and intent slots use the cross-language search too. Onboarding steps delivered 5/20 to 13/20 in one measurement and 8/20 in a later one on the same code: the cross-language terms are written by a model and vary, and some answers hedge ("the full list is not provided") before listing steps. Generalizes to any short follow-up and any regional document in another language.

## Fix 2: clarify on the dimension that changes the answer (built, conservative)

Region stays with the Applicability Layer. After it, a second gate (`lib/applicability/scopeClarification.ts`, `lib/runtime/scopeGate.ts`) asks at most one more question, only when all of these hold:
1. Deterministic candidates: documents that match the *question* (not the replies) about as well as the best one and are written for audiences that share no label. Not for requests to create something.
2. A fast model call must quote, word for word, a sentence from each situation's own material that answers the question; the quote is verified against the excerpt. At least two situations need verified evidence. Material about another topic has nothing to quote, so it cannot be a situation.
3. The judge must say the requirements differ (rules, documents, contracts) and that the user has not already said which applies.
4. At most two clarifying questions per topic, the region question included.

A first version that asked on label differences plus a yes/no judgement over-asked (3/24 on the controls, and it asked "Sales, CS or WE?" on an onboarding follow-up in 4 of 8 runs). Requiring verified evidence removed those.

Final measurement (5 runs, production corpus): over-ask 0/40, re-ask 0/20, follow-through 15/15, contract scenarios 14/20 (baseline 3/12). Remaining failures: on the pilot conversation `contract-brazil` only 2/5 runs are right (both channels covered); in 3/5 the answer follows one channel without saying so, and in none of the five did the gate ask. The recall is low because the evidence requirement is strict and the corpus does not give the gate good material to quote (see content dependencies).

## Content dependencies (not fixable in application code)

- **US onboarding process**: the training itself is not in the corpus, only the announcement.
- **Direct-sales contract guidance for Brazil**: no authoritative playbook. The only contract training for direct sales is the global T3/T4 SMB one; the Brazil contract rules in the corpus are for the partner (indirect) channel. Until Content adds a Brazil direct-sales contract source, the two channels cannot be compared on equal terms.
- **Sales vs CS coaching** (`RKC-000016`, `RKC-000015`): same method and blurb; the "role" scenario of the context-asking eval no longer discriminates on the production corpus.
- **Spanish-only onboarding overview**: the SS Latam onboarding training is in Spanish with no English summary, so English questions depend on the cross-language terms.
- **Explaining Wellhub**: no single source describes how to explain Wellhub to a client; the answer is assembled from pricing, contract and slide material.

## Fix 3: instructions versus mentions (built)

For a how-to question (the cue is read on the topic's opening question, so it survives a one-word reply) the prompt carries an answerability notice: a source counts only if it contains the steps, meaning a sequence of actions, stages, meetings, requirements or rules, in any language and any source type; an announcement, a summary, or a pointer to a document or page that is not itself shown is a reference. Without steps the answer opens with one plain sentence saying so, then states only what the sources establish. Part of a process: give that part and say what is missing. `lib/runtime/answerability.ts`. US onboarding (announcement only): 0/8 before, 10/10 now. Mexico onboarding, where the steps exist: delivered 18/20 (the notice does not cause false "no steps" answers).

## Fix 4: general versus limited guidance (built, partly effective)

A source limited by a registry restriction or written for one or two named audiences gets a "Scope" line, and a notice tells the model to write the general guidance first, put limited content in a separate part that names its situation, present materially different procedures as labelled alternatives, and state the single situation covered when only one is supported (`lib/governance/sourceScope.ts`). Titles that name a tier, segment, channel or program are covered by the same instruction without a pattern list.

Effect: the contract question with the channel unstated went from 3/12 to 18/20 (answers for both channels, or states the channel it covers). "How can I explain Wellhub to a client?" improved only partly: in the runs that answered, about half keep limited content (the US-only pricing narrative, the T3/T4 contract rules) in a separate part; the rest still list it as a numbered section with a label. The notice is advisory, and nothing in code enforces the layout. Two behaviours outside this fix show up in that scenario and are recorded, not changed:
- The Portuguese phrasing of the question is asked "which region?" in 5 of 5 runs, and the English "prospect" phrasing in about half. Region-specific material (Brazil, US) is a close lexical match for these general questions, so the strong-regional-match rule (ratio 0.7, deliberately not tuned before launch) asks. Adding Spanish and Portuguese function words to the stop list did not change this and moved one benchmark question below tolerance, so it was not kept.
- The T3/T4 contract training is labelled audience "Sales ENT" while its content is about the SMB tiers; the answers repeat the mismatch ("Enterprise (T3/T4)"). That is a registry labelling question for Content.

## Integrated result (production corpus, 5 runs per scenario, 2026-11-03)

| Suite | Before the four fixes | Now |
|---|---|---|
| Onboarding steps delivered (F1, 4 scenarios) | 5/20 | 18/20 |
| Contract channel (F2, 4 scenarios) | 3/12 | 18/20 |
| Steps missing: says so up front (F3) | 0/8 | 10/10 |
| Explain Wellhub (F4, 3 scenarios; 6 of 15 runs are region questions) | 2/9 | 4/15 |
| Guards (topic change, contract without context) | 3/6 | 10/10 |
| Over-ask on general questions | 0/24 | 0/40 |
| Pre-supplied context not re-asked | 12/12 | 20/20 |
| Follow-through after the user supplies context | 9/9 | 15/15 |
| Must-ask (tier, segment, role, region) | 18/21 | 28/35 (role 2/5: known eval-design issue; segment 7/10: model variability on an ambiguous question) |
| Synthetic source-conflict cases | 25/25 | 15/15 |
| Retrieval benchmark (local gold set) | baseline | no regression |

The judges are text checks (and one model rubric for F4); the F1 judge was recalibrated during this work to measure steps delivered rather than hedging. Original strict numbers for F1 were 5/20 then 9/20 to 13/20 across runs of the same code.

## Update 2026-11-05: region from the question's language (Product decision) and identity from the file name

**Region from language.** The open decision above (a general Portuguese question asked "which region?" 5 of 5 runs) is closed by Product: for a question written in Portuguese, German, French, Italian or Dutch the region is inferred from the language, so the region question is not asked. Portuguese maps to Brazil; German, French, Italian and Dutch map to Europe. Spanish and English never imply a region (each is used in several operating regions), so those are asked as before. Rules, in `lib/applicability/languageRegion.ts`:
- it is the weakest signal: a region the user names, or one carried from earlier in the conversation, always wins;
- it is never pinned, so a later English reply does not inherit it;
- the prompt tells the model the region was inferred and to follow the user's own words if they place them elsewhere;
- a short reply ("Tier 1") does not decide the language; the earlier question does;
- `HUBI_LANGUAGE_REGION=0` turns it off; the interaction log records `regionSource: "language"`.
Caveat for Product: a Portuguese question from Portugal is treated as Brazil until the user names the country (Portugal belongs to Europe in the approved map).
Language detection (`lib/retrieval/queryExpansion.ts`) gained German, French, Italian and Dutch; such questions also get the cross-language expansion into English.

**Identity.** A file with no Content ID row now takes its identifier from the `[RKC-000NNN]` in its file or folder name, so the registry can govern it (RKC-000069, Not Eligible, was served before because it fell back to its title). A document whose Content ID and file name name different records is excluded and reported, never resolved silently (`lib/ingestion/identity.ts`). On the production corpus RKC-000069 is now excluded; no conflict exists in the deployed bucket (the RKC-000075 document is not in it).
