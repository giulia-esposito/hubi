# Hubi — Product Validation Findings

This is the single source of truth for every product validation finding discovered during internal testing and Revenue rep testing. It is append-only: a new Finding is added every time a validation issue is discovered, never edited away.

**How this works:**
- Engineering populates every field automatically as soon as a finding is investigated: Date, Status, Question, Retrieved documents/chunks, Hubi's response, technical observations, hypotheses, and reproducibility.
- **Expected behavior**, **Product assessment**, **Severity**, **Priority**, and **Product decision** are left blank for the Product Owner to fill in. Engineering does not set these.
- **Status** values: `New` → `Investigating` → `Confirmed` → `In Progress` → `Resolved`, or `Rejected` (Product decides not to act).
- Findings drive the engineering roadmap, but **no fix is implemented until Product reviews and prioritizes it** — an investigation may begin immediately on discovery; implementation always waits.

---

## Finding #001 — Cross-language retrieval gap on Spanish-authored onboarding content

**Date:** 2026-07-21
**Status:** Confirmed (root cause and Product assessment/decision recorded below; expanded scope tracked as Finding #002)

### Engineering follow-up (2026-07-21)
The Spanish-language re-test in this finding confirmed cross-language retrieval *can* work lexically when query and document language match — but Product correctly identified that this is a narrower result than it looks: **matching language is not the same as matching applicable region.** A Spanish query could just as easily match a Spanish document describing a *different region's* process (e.g. SS Latam) than the one actually applicable to the asker (e.g. Spain/Europe), and nothing in the system today would catch that. This is now tracked as its own investigation — see **Finding #002** below, which also confirms this live (a real query, run through the actual pipeline, produced a confident, fully-formed answer built entirely from region-specific content, generalized as if broadly applicable).

### Question
"What meetings do I have to do for client onboarding?"

### Conversation context
Reproduced two ways:
1. **Single-turn, fresh session** — the question asked alone, no prior context.
2. **Multi-turn** — same underlying question, followed by a user clarification "Tier 1 in Brazil" in response to Hubi asking for tier/region. The clarification did not change the outcome.

### Retrieved documents
`[SSL] Proceso de Onboarding Tiers 0, 1 y 2` (RKC-000006) — a Spanish-language document — plus, in the single-turn repro, incidental low-relevance chunks from `US & SSL Competition Training`, `Superhero Academy | Wellhubverse`, and `Launch Readiness no Salesforce [PT]`.

### Retrieved chunks (top 5, single-turn repro)
1. `[SSL] Proceso de Onboarding Tiers 0, 1 y 2 -- 7.2 Paso a Paso` (score 9.45)
2. `[SSL] Proceso de Onboarding Tiers 0, 1 y 2 -- 3.2 Paso a Paso` (score 7.73)
3. `Recorded Session | [Salesloft] Best Practices for Reps -- 1.1 Recording of live session` (score 6.97)
4. `[SSL] Proceso de Onboarding Tiers 0, 1 y 2 -- 1.1 Objetivos y Ventajas` (score 6.15)
5. `[SSL] Proceso de Onboarding Tiers 0, 1 y 2 -- 6.2 Paso a Paso` (score 6.14)

None of the top 5 are the sections that actually name the meeting sequence.

### Hubi response
Consistently and honestly reported that it could not find a defined meeting list, correctly noted the retrieved material references a "Pre Work & Ms Meetings" attachment it doesn't have the contents of, and asked a reasonable clarifying question (tier/region) rather than inventing an answer. Rendered with the "No grounded answer found" treatment in both reproductions.

### Technical observations
The same document (RKC-000006) contains an explicit, well-structured meeting sequence as real section headings: `6.3 Deck de la Reunión de Implementación (M1)`, `7.3 Deck de la Reunión de Estrategia de Comunicación (M2)`, `12.3 Deck Reunión de 30 días`, `13.3 Deck Reunión de 60 días`. This content exists in the ingested text — it is not missing from the knowledge base. It simply never reached the top-5 retrieved chunks:

- Ranked **#16** (`...M1) `) and **#18** (`...60 días`) out of 58 scored chunks *within that one document alone*, when ranked globally across the whole 602-chunk corpus, once other documents' chunks are competing for the same 5 slots, it doesn't surface at all.
- Re-running the identical underlying need as a **Spanish** query ("reuniones que debo hacer para el onboarding del cliente") immediately promoted the correct chunks to **rank #4 and #5**.
- Document-frequency check: `"meeting"` (singular, English) appears in 63 chunks of the corpus — including exactly the attachment references this document needs (`"Kick Off and Implementation Meeting (M1)"`, `"Communication Strategy Meeting (M2)"`, `"Health Checkpoint Meeting"`) — but `"meetings"` (plural, the word actually used in the question) appears in only 17, an entirely separate token to the retrieval index. The tokenizer performs no stemming/lemmatization.
- Prompt size for this turn: 3,434 characters (~577 words) — no truncation logic exists anywhere in the pipeline, and this is far below any realistic model context limit.

### Engineering hypotheses (see full Investigation Report in conversation record for detail)
- **Retrieval ranking / cross-language + non-stemmed lexical mismatch — CONFIRMED root cause.** The retrieval layer is pure lexical BM25 with no stemming and no cross-language matching. An English query cannot lexically match Spanish content ("meetings" vs. "reunión"), and separately, English singular/plural forms ("meeting" vs. "meetings") are treated as unrelated tokens even within the same language.
- **Chunk size / chunk boundaries — contributing/amplifying, not root cause.** The relevant heading's content is split across many small chunks (e.g. the M1 section alone is 12 chunks), diluting per-chunk term frequency. Confirmed real, but a Spanish-language query against the *same* fragmented chunks still ranked them in the top 5 — so fragmentation alone does not explain the failure.
- **Prompt construction — ruled out.** The prompt correctly and completely reflects whatever retrieval provided; no assembly defect found.
- **Context truncation — ruled out.** No truncation logic exists in the pipeline; prompt size is nowhere near any real limit.
- **Reasoning behavior — ruled out as the problem, confirmed working as designed.** Given the (deficient) retrieved context, Hubi behaved correctly: it did not hallucinate a meeting list and it honestly flagged the gap.

### Suggested investigation (if applicable)
None further needed — root cause is confirmed with direct empirical evidence (see conversation record for full Investigation Report, including the exact commands and outputs). Solution options are ready for Product review; no additional engineering investigation is pending.

---

## Reproducibility

**Question:** "What meetings do I have to do for client onboarding?"

**Conversation context:** Reproduces both as a fresh single-turn session and mid-conversation after a "Tier 1 in Brazil" clarification.

**Expected retrieval:** Chunks from RKC-000006's `6.3 Deck de la Reunión de Implementación (M1)`, `7.3 Deck de la Reunión de Estrategia de Comunicación (M2)`, `12.3 Deck Reunión de 30 días`, and/or `13.3 Deck Reunión de 60 días` sections.

**Actual retrieval:** Generic "Paso a Paso" (step-by-step) and "Objetivos y Ventajas" (objectives/advantages) sections from the same document, plus unrelated chunks from other documents — none of which name the actual meeting sequence.

**Can this issue be reproduced? Yes**

**Reproduction steps:**
1. Start a fresh Hubi session (or continue an existing one).
2. Ask: "What meetings do I have to do for client onboarding?"
3. Observe: Hubi reports it cannot find a defined meeting list, points to an inaccessible attachment reference, and the "No grounded answer found" badge appears — even though the real meeting sequence exists as structured headings in the ingested `[SSL] Proceso de Onboarding Tiers 0, 1 y 2` document.

---

## Expected behavior
Hubi should understand a question regardless of the language used and retrieve relevant knowledge across English, Portuguese and Spanish. The language of the query must not determine which regional process is considered applicable.

## Product assessment
The current behavior creates false negatives when the query and source use different languages. This is a structural limitation for a global Revenue knowledge product, not an isolated edge case.

## Severity
High

## Priority
High

## Product decision
Address multilingual retrieval, but do not implement an isolated language-expansion fix that ignores regional applicability. The solution must be designed together with Finding #002.

---

## Finding #002 — Language is not a valid proxy for region; no structural safeguard against confidently-wrong regional answers

**Date:** 2026-07-21
**Status:** Confirmed (root cause and regional-correctness risk empirically verified by Engineering; awaiting Product review below)

### Trigger
Follow-up investigation requested after Finding #001, once Product identified that a linguistically-matched retrieval could still be regionally wrong (e.g. a Spanish-speaking Spain/Europe user matching an SS Latam-specific Spanish document).

### Expanded root cause
Region, audience, segment, and client-tier applicability are **not used anywhere in retrieval, ranking, prompt construction, or citation display** — even where the underlying metadata already exists. The only thing standing between a user and a confidently-delivered wrong-region answer is the Reasoning Engine's own free-text instruction to "ask a clarifying question... if region, segment, client status" matters — a soft, unstructured, unverified dependency, not a structural safeguard. A live test (below) confirms this dependency already fails in a real, reproducible case.

### Current metadata coverage (verified directly against the real corpus)

| Field | Exists at document level? | Exists at chunk level? | Coverage |
|---|---|---|---|
| Region (`targetRegion`) | Yes | **No — discarded during chunking** | 15/15 documents populated, but with inconsistent values: `Global`, `SS Latam`, `Brasil`, `US, SS-Latam`, `BR` (Brasil/BR and SS Latam/SS-Latam are the same real-world regions written inconsistently) |
| Audience (`targetAudience`) | Yes | **No — discarded during chunking** | 15/15 documents populated |
| Language | **No field exists at all** | No | Not tracked; would have to be inferred from raw text |
| Segment / client tier | **No field exists at all** | No | Not tracked as metadata anywhere. Where tier/segment is discussed (e.g. `Client Segmentation - Contract Adherence T3/T4`), it's the document's *subject matter*, not applicability metadata *about* the document |
| Content applicability / global vs. regional scope | Partially — `targetRegion == "Global"` functions as this signal today | No | Implicit only, never asserted structurally |

The `Chunk` type (`lib/ingestion/chunk.ts`) carries only `documentId`, `documentTitle`, `heading`, `text`, `citationUrl`, `citationUrlType` — none of the document-level metadata survives into the object that retrieval, prompting, and citations actually operate on. **The data mostly already exists (100% region/audience coverage); it is simply thrown away before it can be used.**

One further real complication found: a single document can internally cover *multiple* sub-regions that document-level metadata can't distinguish. `RKC-000006` (`targetRegion: "SS Latam"`) references country-specific Playbook attachment variants tagged AR (Argentina) and MX (Mexico) within its own body text, with no Brazil-specific version — a distinction no metadata field captures at any granularity. Document-level region tagging, even if fully wired up, would not resolve this case.

### Does retrieval currently use this metadata? (verified by direct code review)
- **Filtering:** No.
- **Ranking:** No — `lib/retrieval/index.ts`'s BM25 scoring reads only `chunk.heading` and `chunk.text`.
- **Context construction:** No — `lib/runtime/promptBuilder.ts` never includes a chunk's region/audience as structured, labeled context. Region/segment is mentioned only inside the free-text instruction asking the model to use its own judgment.
- **Citation display:** No — neither `lib/runtime/citationBuilder.ts` nor the web UI's source list surfaces region or audience. A human reviewing citations has no signal to catch a wrong-region source either, beyond an inconsistent, informal hint sometimes present in a document's title (e.g. `[SSL]`, `- BR`, `[PT]` — present on some documents, absent on others, never guaranteed).

### Scenario testing (all four, run empirically against the real 602-chunk index; one also run live through the full pipeline)

| Scenario | What was retrieved | Failure type |
|---|---|---|
| **English question about a Brazil process** ("How do I onboard a new client in Brazil without Salesforce?") | The actual Brazil-region document (`Launch Readiness no Salesforce [PT]`, Portuguese) did not appear in the top 5 at all. Generic Global/English content won instead — including `Launch Readiness in Salesforce [ENG]`, a *different process* for a *different region*. | **Confident but regionally/process incorrect answer risk** — the wrong process could be presented as if it were the answer, not just "no answer." |
| **Spanish question from a simulated Spain/Europe user** ("¿Cuál es el proceso de onboarding del cliente en mi región?") | All top 5 were `[SSL] Proceso de Onboarding Tiers 0, 1 y 2` (region: SS Latam), scored very high (25–28, well above typical relevance scores). **Run live through the actual pipeline:** Hubi delivered a complete, well-structured, `turnKind: grounded-answer` response built entirely from this SS-Latam-specific process, stating it is "estandarizado globalmente y adaptado regionalmente" (standardized globally, adapted regionally) — generalizing region-specific content as broadly applicable — and asked for the user's specific region only as a closing afterthought, after already answering in full. | **Confirmed, live: confident but regionally incorrect answer.** The most severe failure category, empirically reproduced, not hypothetical. |
| **Portuguese question about a global process** ("Como faço para criar cadências eficazes no Salesloft?" — Salesloft cadences, an English/Global-region topic) | Retrieved `Opportunity Best Practices - BR` and `Launch Readiness no Salesforce [PT]` — both Brazil-region, neither the actually-relevant Salesloft document (English, Global). Language acted as an accidental **topic** proxy, pulling in same-language-but-wrong-topic content over the correct-topic-but-different-language document. | **Partial/wrong-topic answer risk**, distinct from the region-specific risk above. |
| **No region provided, regional processes differ** ("What is the onboarding process for a new client?") | All top 5 were `Global`-region documents — the safe outcome, in this instance. | **No failure in this specific test** — but incidental (same-language luck: the ambiguous English query didn't share vocabulary with the Spanish/Portuguese regional documents). Would not hold if the ambiguous query happened to share terms with a regional document, as Finding #001 already demonstrated. |

### Failure-type classification (as requested)
- **No answer:** occurs when cross-language mismatch is severe enough that nothing scores well (Finding #001's original case).
- **Partial answer:** occurs when some genuinely relevant content is retrieved alongside same-language-but-wrong-topic noise (Scenario 3 above).
- **Confident but regionally incorrect answer:** the most severe category — **live-confirmed**, not theoretical (Scenario 2 above). This is the one that most directly threatens trust, because it looks exactly like a good answer.

### Recommended prototype-safe approach — options compared

| Option | Expected accuracy | Complexity | Latency | Depends on complete metadata? | Risk: excludes valid global content | Risk: returns wrong regional content |
|---|---|---|---|---|---|---|
| **A. Metadata filtering before retrieval** (hard filter: region ∈ {user's region, Global}) | High *if* the user's region is already known; does nothing for cross-language recall | Medium — requires plumbing region to `Chunk`, canonicalizing region values, and knowing the region *before* the first retrieval | Negligible | High — a filter fully trusts the metadata; canonicalization gaps or the RKC-000006-style sub-region case still cause errors | Low, if "Global" is always included by default | Very low, provided region is known and correctly tagged |
| **B. Metadata-aware reranking after retrieval** (soft boost/demote, no hard exclusion) | Medium — a large lexical-score gap (as seen: 28 vs. typical single digits) may not be overcome by a modest rerank boost | Medium — same metadata prerequisite as A, plus tuning a reranking formula | Negligible | High, same as A | Low (reranking doesn't exclude) | Moderate — doesn't prevent wrong-region content from being used when it's the *only* topically relevant content available, which was exactly Scenario 2 |
| **C. Query expansion (translation) + metadata constraints** | Highest technical accuracy — addresses both the cross-language recall gap (Finding #001) and region correctness together | High — needs a translation/expansion step (likely another Reasoning Engine call) plus everything in A | **Adds a full extra reasoning-engine round-trip per turn** — could roughly double today's ~10–20s response time | High for the metadata half | Low, same as A | Low, same as A |
| **D. LLM-based applicability check after retrieval** (explicit self-check step before answering) | Uncertain on its own — **a weaker version of this already exists** in today's system prompt and just failed to catch Scenario 2 live | Low-medium — mostly a stronger prompt instruction, but only reliable if structured region labels are actually visible to the model (today they aren't) | None (folds into the existing generation call) | Degrades gracefully without metadata (can still reason from prose) but is materially more reliable with it | None directly (advisory, not exclusionary) | Moderate-to-high if implemented as a prompt-only change without metadata support — the live test is direct evidence this alone is not sufficient |
| **E. Hybrid (recommended)**: plumb existing region/audience metadata down to `Chunk` (foundational, low-risk, high-value since coverage is already 100%) → surface it as **labeled, structured context** in the prompt (not a hard pre-filter) → strengthen the clarifying-question instruction to reason over the now-visible label instead of inferring from prose | Directly targets the worst failure category (confident-but-wrong) without needing translation yet | Medium — the metadata-plumbing work is concrete and scoped; the prompt change is small | None added | Benefits from complete metadata but degrades safely (same as D) since it's still an instruction, backed by better data | Low | Meaningfully reduced versus today, though still ultimately advisory unless paired with A/C later |

### Long-term architecture recommendation
Semantic (embedding-based) retrieval would improve cross-language/morphological recall broadly (as already noted in Finding #001), but **it does not solve regional correctness on its own** — semantic similarity has no concept of "which region does this apply to." That remains a metadata/facts problem regardless of retrieval mechanism. The durable direction is embeddings *and* structured metadata filtering together, matching the flexibility `Architecture.md` Section 9 already anticipates.

### Data-quality prerequisites (before any structural metadata approach is viable)
1. Canonicalize region values (`Brasil`/`BR`, `SS Latam`/`SS-Latam` currently represent the same real-world regions with different strings).
2. Decide how to handle documents with internal sub-region variance (RKC-000006's AR/MX attachment split isn't representable at today's document-level granularity).
3. No `language` field exists anywhere — decide whether to add one if cross-language work (Finding #001) proceeds.
4. No segment/tier metadata exists anywhere — a separate, larger metadata-design effort if segment/tier correctness is to be enforced the same way as region.
5. Confirm whether `Global`-tagged documents are reliably, truly universally applicable, or whether some carry undocumented regional caveats — a content-governance question, not a technical one.

### Open Product decisions
1. Hard filter (never show cross-region content) vs. soft signal (show but caveat) — a real UX trade-off between more clarifying questions and more residual risk.
2. How should Hubi learn the user's region — per-question (the only option compatible with this milestone's explicit exclusion of user profiles/accounts) — and is that acceptable friction?
3. Relative priority: fix cross-language recall (Finding #001) vs. fix regional correctness (Finding #002) next — they compound but are separable pieces of engineering work.
4. Should `Global` be trusted at face value, or does Content/Governance need to review it now that it's becoming architecturally load-bearing?
5. Whether to invest in metadata canonicalization + chunk-level plumbing now, or gather more real rep-testing signal first.

### Suggested investigation (if applicable)
None further needed for this finding — root cause, coverage, and live regional-mismatch behavior are all empirically confirmed. Ready for Product review.

---

## Reproducibility (Finding #002)

**Question:** "¿Cuál es el proceso de onboarding del cliente en mi región?" ("What is the client onboarding process in my region?")

**Conversation context:** Single-turn, fresh session, no region stated.

**Expected retrieval:** Either a clarifying question asking which region, or content explicitly scoped/labeled as region-specific.

**Actual retrieval:** Exclusively SS Latam-region content (`[SSL] Proceso de Onboarding Tiers 0, 1 y 2`), scored very high, with no structural signal anywhere that this content is region-specific.

**Can this issue be reproduced? Yes**

**Reproduction steps:**
1. Start a fresh Hubi session.
2. Ask (in Spanish): "¿Cuál es el proceso de onboarding del cliente en mi región?"
3. Observe: Hubi answers in full, citing only SS Latam-specific process content, and generalizes it as broadly applicable before asking for the specific region as an afterthought.

---

## Expected behavior
Hubi should answer using content applicable to the user's business context, particularly region, audience, segment and tier. When that context is missing and regional processes may differ, Hubi should ask a clarifying question before answering.

Language must never be used as a proxy for region.

## Product assessment
A grounded answer based on the wrong regional process is more dangerous than an honest non-answer because it appears trustworthy while being operationally incorrect.

## Severity
Critical

## Priority
Critical — this must be addressed before moderated Revenue rep testing.

## Product decision
Proceed to propose the smallest prototype-safe implementation that combines:

- propagation of existing region and audience metadata to chunk level;
- canonicalization of region values;
- structured applicability metadata in the reasoning context;
- clarification when required business context is missing;
- protection against presenting incompatible regional content as applicable;
- multilingual retrieval that remains independent from regional applicability.

Global content may remain eligible when it is explicitly applicable. Region-specific content from another region must not be presented as the operational answer.

Before implementation, provide a concise implementation plan, success criteria and regression scenarios. Do not introduce embeddings or a vector database unless it can be demonstrated that the prototype-safe approach cannot meet the required behavior.

---

## Finding #003 — Visual Knowledge Loss: process/journey content encoded in slides, decks, and screenshots is invisible to ingestion

**Date:** 2026-08-04
**Status:** Confirmed (root cause, scope, and a live-reproduced example are empirically verified by Engineering below; awaiting Product review)

### Trigger
Product hypothesis, raised after Findings #001/#002: Hubi may be losing knowledge that exists only in visual structures (tables, SmartArt, diagrams, timelines, screenshots) during ingestion, as a third, distinct class of validation issue.

### Question investigated
"I have a new Enterprise client in Mexico. Which onboarding meetings do I need to run?"

### 1. Complete retrieval trace for this question

Ingested corpus: 15 documents, 602 chunks (0 failures), reproduced fresh for this investigation.

Full BM25 ranking was computed (not just the top-5 the product actually uses), so the real rank of every relevant chunk — even ones that never reach the model — could be shown. **289 of 602 chunks scored above zero for this query.**

**Top 5 chunks actually retrieved and sent to the Reasoning Engine (`TOP_K = 5` in `scripts/ask.ts` / `app/api/chat/route.ts`):**

| Rank | Score | Document | Heading | Relevant to the question? |
|---|---|---|---|---|
| 1 | 12.8539 | Client Segmentation - Contract Adherence T3/T4 | 2.3 SMB Contract in Salesforce (Magic Link + Order Form) | No — SMB contract mechanics |
| 2 | 12.1324 | Client Segmentation - Contract Adherence T3/T4 | 1.1 Why this training & when it applies | No |
| 3 | 10.8096 | Client Segmentation - Contract Adherence T3/T4 | 2.2 How to position the pitch | No |
| 4 | 10.4369 | Client Segmentation - Contract Adherence T3/T4 | 1.1 Why this training & when it applies | No |
| 5 | 10.0678 | Client Segmentation - Contract Adherence T3/T4 | 2.3 SMB Contract in Salesforce (Magic Link + Order Form) | No |

None of the top 5 chunks mention onboarding meetings at all. All five come from one unrelated document about SMB vs. Enterprise contract paperwork.

**Live pipeline run** (`node scripts/ask.ts "I have a new Enterprise client in Mexico. Which onboarding meetings do I need to run?"`, real Claude Code call, not simulated):

> "I'm not able to answer this one from what I have. The knowledge I've got is all about contract adherence for T3/T4 clients — specifically making sure deals that finalize as SMB (Tier 3/4) use the SMB contract model, pitch, and service level rather than Enterprise templates. It covers segmentation logic, Magic Link, Order Forms, and clause swaps. There's nothing here about onboarding meetings, sequences, or any Mexico-specific onboarding process for Enterprise clients. You'd want to check a source focused on Enterprise onboarding to get that right."

`turnKind: no-grounded-answer`, `latencyMs` ~9.5s. **The Reasoning Engine behaved correctly given what it was handed** — it honestly refused rather than inventing an answer from the wrong-topic contract chunks. This rules out reasoning as a contributor to this specific failure (see Section 6).

### 2. Does the onboarding meeting sequence exist in the indexed knowledge?

**Yes — all five target concepts exist as searchable text, just not where retrieval could reach them.** The correct source is `RKC-000006` ("[SSL] Proceso de Onboarding Tiers 0, 1 y 2" / folder name "Onboarding ENT SSL" — the actual Enterprise/SS-Latam onboarding document, confirming this is the right document for the question):

| Concept | Found in indexed text? | Where | Rank for this query |
|---|---|---|---|
| Kickoff / Kick-off | Yes | `RKC-000006::s9.0` ("...agendar la reunión de M1 (**Kick-off**) con el cliente"), `RKC-000006::s14.0` heading "6.3 Deck de la Reunión de Implementación (M1)" | rank #112 (score 3.41) and lower; several occurrences unscored (score 0) |
| Implementation Meeting (M1) | Yes | `RKC-000006::s14.*` under heading "6.3 Deck de la Reunión de Implementación (M1)"; full explanation in `s1.1`: *"Quinto paso, reunión de implementación con el cliente M1..."* | **`s1.1` (the chunk with the complete, correct answer) ranked #289 of 289 — dead last among every chunk that scored at all**, score 1.1974 |
| Communication Strategy Meeting (M2) | Yes | `RKC-000006::s17.*` under heading "7.3 Deck de la Reunión de Estrategia de Comunicación (M2)"; also narrated in `s1.2` | `s1.2` scored **0 — not retrieved at all** for this query |
| 30-day Review | Yes | `RKC-000006::s32.*` under heading "12.3 Deck Reunión de 30 días" (Health Checkpoint) | best case rank #44 (a different chunk, score 5.73); the heading's own first chunk ranks #243 |
| 60-day Review | Yes | `RKC-000006::s36.*` under heading "13.3 Deck Reunión de 60 días" (Growth Checkpoint) | best case rank #82, score 4.32 |

**Why they exist but don't rank:** three independent, compounding lexical mismatches, all consistent with Finding #001's already-diagnosed pattern, not a new mechanism:
1. **Cross-language.** The question is English; `RKC-000006` is entirely Spanish. "Meetings" has no lexical overlap with "reunión."
2. **Abbreviation vs. full name.** The question says "Mexico"; the document (and the whole 602-chunk corpus) only ever writes "**MX**" or "**[MX]**" (9 occurrences in `RKC-000006` alone). The literal string "Mexico" appears in exactly **1 chunk in the entire corpus** — not this document. BM25 has no abbreviation expansion, so "Mexico" cannot match "MX" at all.
3. **Non-stemming, already known from Finding #001.** "Meetings" (plural, English) vs. "reunión"/"reuniones" (Spanish) — no shared tokens regardless of the above.

**This is not a new failure mechanism.** It is Finding #001's cross-language/non-stemmed retrieval gap, reproduced with a new example. **For this specific question, visual content loss is not the operative cause** — see Section 6 for the full classification.

### 3. Inspection of the original source document's visual structure

Direct inspection of `RKC-000006`'s real DOCX (`readZipEntries` + raw `word/document.xml`, not assumed from the extracted text):

- **`word/media/*` (embedded images): 0.**
- **`word/diagrams/*` (SmartArt data/layout parts): 0.**
- **`word/embeddings/*` (embedded objects): 0.**
- **`<w:drawing>` (any inline/anchored image, SmartArt, or shape): 0 occurrences** in `word/document.xml`.
- **`<w:pict>`: 11 occurrences — all confirmed to be plain horizontal-rule divider lines** (`<v:rect style="width:0.0pt;height:1.5pt" o:hr="t" .../>`), not pictures or diagrams.

**Conclusion: this specific document contains no visual graphics of any kind.** Its "onboarding journey" is represented entirely as: (a) narrated prose transcribed from a recorded presenter walking through slides (video transcripts embedded as ordinary paragraph text — the same pattern already confirmed safe in `Prototype_Plan.md` Appendix B.3), and (b) a few plain tables. The visual-loss hypothesis, tested literally against this document, is **not what's happening inside this file**.

**However, a different and unexpected loss vector was found in this same document: the visual materials are named but never present.** `RKC-000006`'s text references a companion slide/deck for nearly every step — 35 distinct `Attachment:`/`Attachements:` lines across its 40 sections, including (verbatim):
- *"6.1 ... Attachements: **Kick Off and Implementation Meeting(M1)**"*
- *"7.1 ... Attachements: **Communication Strategy Meeting (M2)**"*
- *"3.3 Presentación Diapositiva de Próximos Pasos ... Attachements: **Próximos pasos**"* (a "Next Steps" slide — its own section text explicitly describes it as *"esta diapositiva ... muestra las etapas principales entre la firma del contrato y el lanzamiento oficial"*, i.e. exactly the visual roadmap/timeline the investigation was asked to look for)
- *"1.2 ... Attachements: **Milestones Onboarding** ..."*, *"9.3 ... Attachements: [SSL] Suggested Launch Plan by Tier (T0 - T2)"*, *"12.3 ... Attachements: [Rev. Strategy] [MX] Health Checkpoint Deck"* (Mexico-specific)

**None of these attachments exist anywhere Hubi can reach them.** The real Content Repository folder for `RKC-000006` (`Content Repository/.../[RKC-000006] Onboarding ENT SSL/`) contains exactly three files: the `.docx` and two `.mp4` videos — **no deck, slide, or playbook file of any kind.** These are references to visual assets that were never exported from the source system into Hubi's local Content Repository at all — a gap upstream of ingestion, not a parsing defect.

### 4. Original document vs. extracted text — corpus-wide comparison

Since `RKC-000006` itself has zero graphics, the corpus was scanned document-by-document (all 15 real DOCX files, direct ZIP/XML inspection) to check whether visual content loss is real anywhere else in the current knowledge base:

| Document | Embedded images (`word/media/`) | SmartArt (`word/diagrams/`) | `<w:drawing>` occurrences | Largest image |
|---|---|---|---|---|
| RKC-000002 (Salesloft Best Practices) | 0 | 0 | 0 | — |
| RKC-000004 (Wellhubverse — The Map to our Universe) | **17** | 0 | 18 | 1.87 MB |
| RKC-000005 (Wellhubverse Live Session) | 1 | 0 | 1 | 366 KB |
| RKC-000006 (Onboarding ENT SSL) | 0 | 0 | 0 | — |
| RKC-000008/012/014/015/016/018/020/023 | 0 | 0 | 0 | — |
| RKC-000021 (What is Wellhub — Elevator Pitch) | 1 | 0 | 9 | 70 bytes (trivial) |
| **RKC-000026 (Salesforce Hierarchy & Data Enrichment AI)** | **16** | 0 | 20 | 66 KB |
| **RKC-000027 (Opportunity Best Practices - BR)** | **14** | 0 | 14 | 1.95 MB |

**5 of 15 real, currently-ingested documents (33%) contain real embedded images — 62 `<w:drawing>` occurrences total, several individual images approaching 2 MB (plausible full-resolution UI screenshots, not icons or dividers). Zero SmartArt diagram parts exist anywhere in the current corpus** — the SmartArt-specific concern is architecturally real (see Section 5) but not yet evidenced in this specific 15-document sample.

**Confirmed real information loss, not just a hypothetical risk:** `RKC-000026::s3.0`/`s3.1` (heading "1.2 Presentation on New Hierarchy view and Data Enrichment," which sits under **9 embedded images**) reads, verbatim, in the extracted text actually sent to the model today:

> *"As you can see, we now have this new sub-tabs... double-check here the view hierarchy button... to leverage the AI enrichment tool, start by clicking the button below... Check out the video below!"*

The narration is preserved (it's spoken-word video transcript, captured as plain text like the rest of the corpus), but every deictic reference — "as you can see," "here," "the button below" — points at a screenshot that is silently and completely absent from what Hubi has. Nothing marks that anything is missing; the sentence just reads as if the picture were there.

### 5. Is OCR performed anywhere in the ingestion pipeline?

**No.** Confirmed by direct code inspection (`lib/ingestion/docx.ts`, `lib/ingestion/zip.ts`, `lib/ingestion/normalize.ts`, `lib/ingestion/chunk.ts`, `package.json`):
- `parseDocxRaw()` extracts only `<w:p>` (paragraph) and `<w:tbl>` (table) blocks via regex over `word/document.xml`. There is no code path anywhere that reads `word/media/*`, `word/diagrams/*`, or `word/embeddings/*`, and no code path that reads a drawing's `<wp:docPr>` `name`/`descr` attributes (the DOCX accessibility alt-text field) either — even that minimal fallback is not captured today.
- `package.json` has exactly five runtime dependencies (`next`, `react`, `react-dom`, `react-markdown`, `remark-gfm`) — no OCR library (e.g. Tesseract), no image-captioning dependency, no vision-model call anywhere in `lib/`.
- This is consistent with, and was already an explicit decision recorded in, `Prototype_Plan.md` Section 4/B.3 — video/image files were deliberately not parsed because *"real transcripts are already embedded as text in the DOCX Core Knowledge Body."* That reasoning is confirmed correct for embedded video transcripts (plain text, captured fine) but **does not extend to embedded static images** — no equivalent transcript exists for a screenshot, and nothing currently recovers one.

**Precisely what is lost without OCR or any image-text extraction, based on what's actually in this corpus today:**
- Any text that exists only inside a screenshot (UI labels, field names, exact button text) — confirmed real in RKC-000026.
- Any process/timeline/roadmap graphic represented as a picture rather than prose — not found inside any of the 15 documents themselves (0 SmartArt, and the images found are UI screenshots and a "map"-style graphic, not confirmed timeline diagrams), but confirmed as a *named, expected* asset for `RKC-000006` specifically (the "Próximos pasos" / "Milestones" attachments) that was never exported into Hubi's reach at all (Section 3).
- Alt-text/accessibility descriptions on images, if authors ever added them — not extracted even though the data model (`<wp:docPr descr="...">`) supports it.

### 6. Root cause classification

Both parts of the investigation converge on the same conclusion, but for **different, coexisting reasons** — this is not one bug, it's two:

- **For the reproduced question specifically: retrieval, not visual content loss.** The correct answer exists in full as plain extractable text (Section 2); it simply never ranks in the top 5 under today's non-stemmed, cross-language-blind BM25, for the same structural reason Finding #001 already root-caused. Chunking is not implicated — the relevant chunks are reasonably sized and correctly headed. Reasoning is not implicated — Hubi refused safely rather than fabricating an answer from the wrong-topic chunks it was actually given (Section 1). Extraction is not implicated *for this document* — nothing in `RKC-000006` itself was silently dropped, because it contains no visual elements to drop.
- **As a distinct, independently confirmed architectural gap: real visual content loss, in two different forms.** (a) **In-document image loss** — 5 of 15 real ingested documents contain embedded images with confirmed dependency between the surrounding text and the (missing) image content (`RKC-000026`); today's ingestion has zero code path to recover any signal from them, silently and without warning. (b) **Referenced-but-never-exported visual assets** — `RKC-000006` alone names 35 companion decks/slides it depends on (including one, "Próximos pasos," explicitly described as the visual roadmap the investigation was asked to look for), none of which exist anywhere in the local Content Repository — a repository-completeness gap upstream of Hubi's ingestion code entirely, not a parsing defect.

**In short: the specific question given did not fail because of visual content loss — it failed because of the already-known Finding #001 retrieval pattern. But the investigation this question triggered independently confirms that visual content loss is real, present in the current corpus today, and architecturally distinct from Findings #001 and #002 — a genuine third class of validation issue, just not the explanation for this particular reproduction.**

### Data-quality / scope prerequisites (before any structural fix is designed)
1. Confirm whether the Content Repository export process can be extended to include referenced decks/attachments (Section 3's "Próximos pasos"-style gap), or whether that's a Google Drive/WorkRamp export-process fix outside Hubi's own codebase.
2. Decide whether image-text extraction should start with the cheapest signal (alt-text/`docPr descr`, which costs nothing and is already present in the file format but wholly unread today) before considering OCR or a vision-model call, given the project's stated cost/latency discipline.
3. No image currently in the corpus has been confirmed (by a human reviewer) to contain business-critical text that isn't otherwise stated in the surrounding transcript — `RKC-000026` is the one case checked in depth here; the other 4 image-bearing documents warrant the same manual check before prioritizing a fix.
4. SmartArt/diagram-part handling has no real example to build or test against yet in this corpus (0 occurrences found) — worth deciding whether to build for it proactively or wait until a real instance appears.

### Open Product decisions
1. Is recovering image-dependent text (Section 4's `RKC-000026` example) worth the cost/complexity of OCR or a vision-model call, or is flagging affected sections for human follow-up a sufficient prototype-safe interim step?
2. Should the Content Repository export process be revisited so that referenced attachments (decks, milestone slides) are actually included, given at least one confirmed case (`RKC-000006`) where the named-but-missing asset is precisely the kind of roadmap/timeline content this investigation was asked to look for?
3. Relative priority against Findings #001/#002 — this finding did not cause the reproduced failure in this investigation, which may argue for lower urgency than Finding #002's already-Critical rating, but the confirmed `RKC-000026` example shows the gap is real today, not speculative.
4. Whether a cheap, deterministic "this section references N image(s)/attachment(s) not captured" flag (metadata-only, no OCR) is worth adding to ingestion output and/or citations as an interim transparency measure, independent of whether or how the content is ever recovered.

### Suggested investigation (if applicable)
None further needed to confirm this finding — visual content loss is empirically demonstrated (`RKC-000026`), its absence is empirically confirmed as the explanation for *this* reproduced question (`RKC-000006` has no visual elements at all), and the corpus-wide inventory (Section 4) and OCR-absence check (Section 5) are both complete. A follow-up worth flagging, not yet done: manually reviewing the other 4 image-bearing documents (`RKC-000004`, `RKC-000005`, `RKC-000021`, `RKC-000027`) the same way `RKC-000026` was reviewed here, to know how many of the 5 actually carry information loss versus purely decorative images.

### Engineering addendum (2026-08-04, later same day) — independent corroborating evidence, and a corpus-volatility observation

Re-ran this investigation's core checks independently (before discovering the analysis above already existed in this file) and arrived at the same root-cause classification by a different path. Recording the additional evidence rather than duplicating what's already written above, since it materially strengthens the finding:

- **The Content Repository is no longer a static 15-document corpus.** Over the course of this same day, two new documents were added directly to the local `Content Repository` folder outside the original `[RKC-XXXXXX]` folder convention: **"Sales Tools Playbook - Revenue Team"** and **"Rules of Engagement."** The corpus is now **17 documents / 1,282 chunks**, up from the 15/602 baseline this finding was originally investigated against. Re-running the exact reproduction question today returns a *different* wrong top-5 (now dominated by the new Sales Tools Playbook, not `Client Segmentation - Contract Adherence T3/T4`) — the specific wrong document changes as the corpus grows, but the outcome (correct chunks never rank) does not. **Anyone re-running the Reproducibility steps below should expect the exact retrieved chunks to differ from what's recorded there; the failure itself will still reproduce.**
- **A far more extreme, independently-found example of the same in-document image-loss mechanism:** the new **Sales Tools Playbook** contains **763 embedded images** (`word/media/*.png`, confirmed via direct ZIP inspection) — by a wide margin the most image-dense document in the corpus, well beyond `RKC-000026`'s 9. Its extracted text contains at least **8 chunks with a direct, unambiguous dangling visual reference** — sentences that explicitly tell the reader to look at a screenshot that was never captured, e.g. *"your inbox will look like the screenshot below"* (`Sales Tools Playbook - Revenue Team::s3`), *"See the screenshot below for a demonstration"* (`::s266.0`, itself part of the Mexico-specific "Hidden Fields for Argentina, Chile, Mexico, Brazil, and Italy" section), and *"as shown in the image below"* (`::s68`). Unlike `RKC-000026`'s narrated-transcript case (where the spoken words partially compensate for the missing image), these are written procedural instructions where the image *was the instruction* — there is no narration filling the gap.
- **Independently re-confirmed, via the same direct-ZIP method, that `RKC-000006` has exactly one real table** (the Document Metadata table, correctly excluded from body content by design) **and zero images/SmartArt/embeddings** — a naive substring count of `"w:tbl"` in the raw XML initially suggested 28 tables; precise tag-boundary matching (`<w:tbl>` vs. `</w:tbl>` open/close pairs) showed this was inflated by sibling elements sharing the substring (`w:tblPr`, `w:tblGrid`, `w:tblStyle`, etc.) around that same single table. Recorded here so the same false lead isn't rediscovered later.
- **Corpus-wide image census, independently re-run today (16 documents at the time, before "Rules of Engagement" was added):** confirms Section 4's finding and extends it — **7 of 16 documents now contain embedded images** (adding the Sales Tools Playbook to the 5 already identified in Section 4, out of a slightly larger sample), reinforcing that this is a recurring, not isolated, pattern as the knowledge base grows, not just a property of the original 15-document snapshot.

**This addendum does not change the finding's root-cause classification** (Section 6): for the specific reproduction question, the failure is still retrieval, not visual loss — now compounded by uncontrolled corpus growth diluting an already-cross-language-blind ranking function further. Visual content loss remains real, present, and architecturally distinct, now with a more severe example on record.

---

## Reproducibility (Finding #003)

**Question:** "I have a new Enterprise client in Mexico. Which onboarding meetings do I need to run?"

**Conversation context:** Single-turn, fresh session, no prior context.

**Expected retrieval:** Chunks from `RKC-000006`'s "1.2 Visión General de los Pasos" (full sequence overview) and/or its M0/M1/M2/30-day/60-day step-by-step sections.

**Actual retrieval:** All top-5 chunks from `Client Segmentation - Contract Adherence T3/T4` — a document about SMB-vs-Enterprise contract paperwork, topically unrelated to onboarding meetings.

**Can this issue be reproduced? Yes.**

**Reproduction steps:**
1. Start a fresh Hubi session (terminal: `node --experimental-strip-types scripts/ask.ts "I have a new Enterprise client in Mexico. Which onboarding meetings do I need to run?"`, or the Web UI).
2. Observe: retrieval returns 5 chunks, all from the wrong document; Hubi correctly reports it has no grounded information on onboarding meetings (`turnKind: no-grounded-answer`) rather than guessing.
3. Separately, to reproduce the confirmed visual-loss example: ingest the corpus and inspect `RKC-000026`'s chunks under heading "1.2 Presentation on New Hierarchy view and Data Enrichment" — the text reads as a screen-share narration ("as you can see," "the button below") with no image content behind it, because `word/document.xml` in that file contains 9 `<w:drawing>` references (confirmed via direct ZIP/XML inspection) that `lib/ingestion/docx.ts` has no code path to read.

---

## Expected behavior

## Product assessment

## Severity

## Priority

## Product decision
