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
3. **Cross-language is the one structural gap.** A Spanish question about pricing, or an English question about a Portuguese document, finds nothing relevant in the top 15 in 3 of 4 cases. BM25 has no vocabulary overlap to work with, and no amount of tuning changes that. The corpus is multilingual (English, Spanish, Portuguese) and so are the users, so this will occur in the pilot.

## Recommendation (for Product to confirm)

- **Not needed now: embeddings or a vector store.** The measured failures that are not cross-language are ranking, and ranking has cheaper levers (retrieval depth, document-level signals) that the benchmark can now evaluate one at a time.
- **Needed: cross-language recall, by conditional query expansion.** When the lexical result is weak and the question's language differs from the likely source language, ask the model once for the question's key terms in the other corpus languages, search with both, and merge. This is the "conditional multilingual expansion" already in `docs/context-applicability-architecture.md` Section 6 (not yet built). It adds a model call only on the weak-result path, needs no new infrastructure and has no vendor lock-in beyond the model call the product already makes. Verify with the 4 cross-language cases and add more before building.
- **Revisit embeddings only if** expansion leaves cross-language or paraphrase recall below target after tuning, or if the corpus grows past what term matching can rank. That would be an architecture and cost decision (an embedding index built at startup, a second model dependency) and should be a separate proposal with numbers from this benchmark.

## Limits, stated plainly

- The gold labels are one engineer's reading of the corpus, not a reviewed ground truth. Several are deliberately broad (any chunk of a document). They need review by Content before the numbers are quoted outside the team.
- 45 questions, 4 of them cross-language: enough to show the gap, not to size it. Real pilot questions (from the interaction log) should be added as they accumulate.
- It measures retrieval, not answers. Whether the model uses the retrieved passage well is covered by the other evals.
