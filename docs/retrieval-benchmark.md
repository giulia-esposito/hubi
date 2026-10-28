# Retrieval benchmark

A repeatable recall benchmark for the lexical retrieval layer. It exists so that any change to tokenization, chunking, scoring or retrieval depth is judged by numbers, and so the question "do we need hybrid or semantic retrieval, and where?" is answered by evidence.

- Gold set: `benchmarks/retrieval/gold.json` (45 questions, each with the passages that answer it and an optional region context).
- Scoring: `lib/retrieval/benchmark.ts` (pure; unit-tested offline).
- Runner: `npm run eval:retrieval` (`--misses` lists failures, `--check` compares with `benchmarks/retrieval/baseline.json`, `--write-baseline` records a new baseline). No model call, deterministic, about a second on the real corpus.
- Guard: `tests/retrievalBenchmark.test.ts` runs the same benchmark inside `npm test` when the corpus is present and fails on a drop in Recall@5, Recall@15 or MRR (tolerance 0.02).

Two layers are measured. **Raw** is BM25 top 15 over the governed index (the pass-1 depth). **Served** is what the model actually receives after the Applicability Layer and the fact pass; the question is given a region context where the document is region-specific, so legitimate withholding is not counted as a miss.

## Baseline (2026-10-29, 2,099 governed chunks)

| Category | n | Raw R@5 | Raw R@15 | Raw MRR | Served R@5 |
|---|---|---|---|---|---|
| exact-term (names, tools, SKUs) | 16 | 100% | 100% | 0.90 | 94% |
| paraphrase (no shared keywords) | 12 | 75% | 100% | 0.64 | 75% |
| spanish | 5 | 100% | 100% | 1.00 | 100% |
| portuguese | 5 | 100% | 100% | 0.90 | 100% |
| artifact (pitch, email) | 3 | 100% | 100% | 1.00 | 100% |
| **cross-language** (question and document in different languages) | 4 | **25%** | **25%** | 0.25 | **25%** |
| **all** | 45 | 87% | 93% | 0.79 | 84% |

## What it shows

1. **Same-language lexical retrieval works.** Exact terms and same-language Spanish and Portuguese questions are found. Typing Spanish or Portuguese without accents made no difference (checked with three dedicated cases), so there is no evidence for an accent-folding change.
2. **Paraphrases are found but ranked low.** Every paraphrase has its answer within the top 15 and 75% within the top 5; the model sees about five sources, so the three misses at rank 6-7 (`pitch-structure`, `request-enablement`, `competition-us`) are lost to ranking, not to absence.
3. **Cross-language was the one structural gap** (addressed below). A Spanish question about pricing, or an English question about a Portuguese document, finds nothing relevant in the top 15 in 3 of 4 cases. BM25 has no vocabulary overlap to work with, and no amount of tuning changes that. The corpus is multilingual (English, Spanish, Portuguese) and so are the users, so this will occur in the pilot.

## Conditional query expansion (built, on by default)

Product approved the recommendation, so cross-language expansion is in (`lib/retrieval/queryExpansion.ts`, wired in `app/api/chat/route.ts` and `scripts/ask.ts`). It adds one small model call before retrieval, only when it is likely to help:

- a **Spanish or Portuguese** question is expanded into English search terms (the corpus is mostly English, and the lexical score cannot be trusted for these questions: Spanish function words match the Spanish documents strongly while the answer sits in an English one);
- an **English** question is expanded into Spanish and Portuguese terms only when its best BM25 score is weak (below 12).

The two rankings are fused by reciprocal rank fusion (equal weights for a non-English question, the original ranking favoured for a weak English one), then everything downstream is unchanged: governance, the Applicability Layer, the fact pass. The model only ever supplies search words, never answer text. The language guess is a stopword and character heuristic (tested), because it only decides whether to spend a call. A failed, slow (10s limit) or empty expansion falls back to plain BM25 silently, and a helper call is never retried. `HUBI_QUERY_EXPANSION=0` switches it off. Each triggered turn logs the reason, language, terms, latency and any error (`retrieval.expansion` in the interaction log).

### Measured (same 45 questions; expansions recorded from the live model in `benchmarks/retrieval/expansions.json`, so the numbers replay offline)

| | Raw R@5 | Raw R@15 | Raw MRR | Served R@5 |
|---|---|---|---|---|
| plain BM25 | 87% | 93% | 0.789 | 84% |
| **with expansion** | **91%** | **98%** | **0.817** | **91%** |
| cross-language only (n=4) | 25% to 50% | 25% to 75% | 0.25 to 0.39 | 25% to 75% |

- Triggered on 17 of 45 benchmark questions (12 non-English, 5 weak English), which over-represents non-English questions by design; the real share is unknown until pilot traffic exists.
- Cost when triggered: about 0.9s of model time with extended thinking disabled for this call (it was 3.2s with default thinking, with similar recall), plus the tokens of one short call.
- Gains: a Spanish pricing question and a Spanish pitch request now find the English documents; a paraphrased pitch question moves from rank 7 to rank 1.
- No lost answers, one cost: same-language Portuguese questions keep every hit in the top 15 (Recall@5 100%), but an English-expansion result can push the right passage down a place (Portuguese MRR 0.900 to 0.867).
- Still missing: an English question about Portuguese content (`en-pt-rejection`). The model's terms were right ("rejeitadas") but the document says "Rejeição": different word forms, and BM25 has no stemming. That is a morphology limit, not a language one.
- Tried and rejected: folding accents and adding Spanish and Portuguese stopwords to the BM25 tokenizer. It improved plain cross-language recall a little but lowered recall with expansion (R@5 91% to 89%, served 91% to 84%), so it was reverted. The benchmark is what made that a quick, evidence-based call.

### What this does not change

- Embeddings and a vector store are still not needed: after expansion the remaining misses are ranking (ranks 6 and 7 for three paraphrases) and word forms, each with cheaper levers. Revisit only if pilot traffic shows cross-language or paraphrase recall below target after tuning.
- The guard: `npm run eval:retrieval -- --expand --check`, and the same replay runs inside `npm test`. After changing the expansion prompt or model, re-record with `--expand-live` (needs the provider configured) and review the diff.

## Limits, stated plainly

- The gold labels are one engineer's reading of the corpus, not a reviewed ground truth. Several are deliberately broad (any chunk of a document). They need review by Content before the numbers are quoted outside the team.
- 45 questions, 4 of them cross-language: enough to show the gap, not to size it. Real pilot questions (from the interaction log) should be added as they accumulate.
- It measures retrieval, not answers. Whether the model uses the retrieved passage well is covered by the other evals.
