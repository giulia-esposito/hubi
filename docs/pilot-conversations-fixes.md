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

## Fixes 3 and 4

Not built yet. See the plan at the end of this file once they are.
