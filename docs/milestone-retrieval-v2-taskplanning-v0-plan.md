# Milestone Plan: Retrieval V2 + Task Planning V0

**Status: implementation plan, not yet approved. No code, prompts, or data files have been created or modified to produce this — planning only, per instruction.** Scope: implement the already-approved V0 boundary from `docs/context-applicability-architecture.md` (Retrieval V2) together with the smallest possible slice of `docs/task-planning-architecture.md` (Task Planning V0: three-mode classification only — no outcome inference, no artifact-candidate menus, no query reshaping). Everything beyond this explicit scope is deliberately deferred, per direction.

---

## 0. A material input to this plan: live registry data

Before writing this plan, I confirmed direct read access (via the Drive connector available in this session) to the actual `RKC | Revenue Knowledge Center - Content Registry` Google Sheet and pulled the real, current governance rows for all 15 documents in Hubi's local Content Repository. This is not reconstructed or estimated data — it's a live read, done just now. Headline findings that shape this plan:

- **`RKC-000021` is confirmed `AI Eligibility: Not Eligible`** — this is the live governance gap flagged in `docs/context-applicability-architecture.md` and it is still true today.
- **`RKC-000012` is confirmed `AI Eligibility: Eligible with Restrictions`, `Issues/Risks: Incomplete Content`**, with an explicit note: *"It was only released for US and was not fully implemented."*
- All 15 documents are `Content Status: Active` — Content Status filtering has no visible effect on this specific 15-document set today, but the gate still needs to exist correctly for when it does.
- Real, confirmed `Region/Country` values in use: `Global`, `SS Latam`, `United States, Europe`, `United States, SS Latam`, `Brazil` — no messy variants (`SS-Latam`, `Brasil`) exist *in the registry itself*; that inconsistency is specific to the local DOCX metadata, confirming canonicalization needs to reconcile DOCX-local values against the registry's cleaner vocabulary, not the other way around.
- Real `Language` values in use: `English`, `Spanish`, `Portuguese`, and one multi-language row (`English, Portuguese, Spanish` for `RKC-000021`) — this is the exact, real language set the conditional multilingual expansion should target, not a hardcoded guess.
- Registry `Audience` values are richer than local DOCX metadata for every document checked (e.g. `RKC-000006`'s registry audience is `Enterprise Sales, Enterprise Client Success, Wellbeing Engagement, Channel Partners, Revenue Managers` vs. the DOCX's plain `Sales, CS, WE`) — confirming the registry, not the DOCX, should win when both exist.

**Because the local prototype has no direct Google API/OAuth access by design (`Architecture.md` Section 15), this live read cannot become an on-demand call from Hubi's own runtime.** The correct, already-approved shape (`docs/context-applicability-architecture.md` Section 5: *"Manual synchronization (recommended for V0)"*) is a manually-captured snapshot file the sync script reads from — exactly how the Content Repository's own DOCX files are themselves a manual export, not a live Drive connection. This plan proposes writing that snapshot using the real data just confirmed, not placeholder or fabricated values — this is a meaningful quality improvement over inventing test fixtures, and it directly grounds the plan's validation scenarios in the actual live governance state.

---

## 1. Scope boundary, restated precisely

**In scope:**
- Retrieval V2, matching `docs/context-applicability-architecture.md` Section 10 items 1–5 (manual sync, chunk-level region/audience/eligibility/status, Applicability Layer, labeled prompt+citations, conditional multilingual expansion). Item 6 (session-level User Context intake) is explicitly **not** in scope — matches this milestone's own instructions, which never ask for a context-intake UI.
- Task Planning V0: a single, minimal classification — **Knowledge Retrieval / Knowledge Synthesis / Business Assistance** — that selects reasoning behavior only. No outcome inference, no artifact-candidate menus, no query reshaping, no workflow planning.
- Business Assistance construction latitude, with an explicit, non-negotiable claim-level grounding boundary.

**Explicitly out of scope (per this milestone's own instructions, and per the standing three-round architecture review):**
- Outcome understanding (`docs/task-planning-architecture.md` Section 10) — deferred.
- Optional-candidate-artifact offering (`docs/task-planning-architecture.md` Section 11) — deferred.
- Task-Planning-informed retrieval query reshaping — deferred; this milestone's retrieval improvements come entirely from Retrieval V2's own governance/language mechanisms, not from Task Planning.
- Conversation Continuity, Web App identity — untouched, as always.

---

## 2. Design decisions this plan makes, flagged explicitly rather than silently assumed

Several items in `docs/context-applicability-architecture.md` Section 13 were deliberately left open, with explicit permission to "begin with a conservative default and confirm along the way." This plan exercises that permission. Flagging each choice here so it can be vetoed before any code is written:

1. **`Eligible with Restrictions` (`RKC-000012`) is treated as usable, not excluded — but always rendered with a visible restriction/incomplete-content caveat in both the prompt context and the citation.** Hard-excluding it wasn't asked for; silently treating it as fully eligible would hide a real, registry-confirmed caveat (`Incomplete Content`, `"only released for US and was not fully implemented"`).
2. **Content Status exclusion applies only to `Draft`, `Deprecated`, `Archived`** — matching the specific wording already used everywhere this has been discussed (`Product_Architecture.md`'s own decision-list item 2: *"excluding retired/deprecated/archived assets"*). `Under Review` and `Update Required` remain usable; `Update Required` gets the same visible-caveat treatment as `Eligible with Restrictions`, since both represent "usable, but flagged."
3. **Region-to-country canonicalization mapping is engineering-maintained for V0** (a small, explicit lookup table, e.g. `Mexico → SS Latam`, `Argentina → SS Latam`, `Brazil → Brazil`, `United States → United States`), not a new registry field — the cheaper of the two options `docs/context-applicability-architecture.md` Section 13 left open, consistent with not introducing new registry-governance process as part of an engineering milestone.
4. **The multilingual-expansion "sufficiency" threshold is a single tunable constant**, seeded from what was actually observed during the Finding #001/#003 investigations (relevant results scored 5–28; irrelevant noise scored 1–3), not a value asserted as final — flagged explicitly as needing real-usage tuning later, matching `Implementation_Handoff.md` Section 7's own open item.
5. **Task Planning mode is determined by Claude Code's own self-report inside the single existing reasoning call — not a second model call.** This directly satisfies the cost/latency constraint flagged in `docs/task-planning-architecture.md` Section 6, and reuses the exact mechanism (`turnKind`'s trailing self-tag, extended to a second tag) already validated and shipped for `turnKind` itself.
6. **The registry sync remains manual and file-based, not a live API integration** — no Google credentials or OAuth are introduced into the running application, matching `Architecture.md` Section 15 exactly. Refreshing the data later means repeating this same manual export step.

---

## 3. Architecture, as it will actually run

```
User Message
  → Session State (unchanged: sessionState.ts, accumulatedUserQuery)
  → Knowledge Base (knowledgeBase.ts, NOW applicability-gated):
        ingest → load registry cache → attach region/audience/aiEligibility/contentStatus to every Chunk
              → filterEligible() [HARD GATE: excludes Not Eligible / Pending Assessment / Draft / Deprecated / Archived
                                   from the searchable index entirely — these chunks never reach BM25 at all]
              → buildIndex() over the eligible set only
  → Retrieval (search(), mechanism UNCHANGED — same BM25):
        1. search on the accumulated query, over the eligible index
        2. sufficiency check (deterministic, free): top score below threshold, or top results are
           exclusively region-specific with no Global fallback → INSUFFICIENT
        3. if insufficient: ONE conditional Claude Code call (reusing the existing adapter) to expand
           the query into the registry's real Language set (English/Portuguese/Spanish today, derived
           from the cache, not hardcoded) → re-run search, merge + re-rank + dedupe with the original results
        4. if the expansion call fails: fall back to the original results, never a hard failure
  → Applicability labeling (deterministic, always runs, zero LLM cost):
        each surfaced chunk gets a label: region, audience, aiEligibility (incl. "Restricted" caveat),
        contentStatus (incl. "Flagged" caveat) — attached for both the prompt and the citation display
  → Clarification gate (deterministic, zero LLM cost):
        if every surfaced result is region-specific (no Global among them) AND the conversation's own
        text contains no recognizable canonical region/country term → set a hard "must ask region" flag
  → Prompt Builder V2:
        - labeled context blocks (region/audience/eligibility shown per source)
        - the hard clarification flag, if set, becomes an explicit, non-negotiable instruction
        - mode-specific behavior rules for the single reasoning call to follow (see Section 5)
  → Reasoning (ONE Claude Code call, same as today):
        internally determines planningMode (Knowledge Retrieval / Knowledge Synthesis / Business
        Assistance) from the literal request, applies the matching behavior rule, constructs the
        response, self-tags BOTH turnKind and planningMode as trailing tags (extends the existing,
        already-validated tag mechanism — does not replace it)
  → Citation Builder V2 (region/audience label now shown per citation)
  → Interaction Log V2 (schemaVersion: 2, planningMode, applicabilityFlag, metadataSyncedAt, richer sources[])
```

**What does not change, restated as a hard checklist against the non-negotiable constraints:**
- Governance/Applicability run identically regardless of planningMode — the eligibility gate happens during index-building, before retrieval, before Task Planning's mode determination even occurs. Mode has no code path that can touch it.
- Every factual claim, in every mode, still must trace to retrieved knowledge — Business Assistance's added latitude is explicitly scoped to structure, framing, and general communication craft, never to specific facts.
- Task Planning does not reshape or filter retrieval — Retrieval V2's improvements (eligibility, region-awareness, multilingual expansion) are fully independent of which mode is eventually determined.
- No new npm dependency of any kind — canonicalization is a lookup table, the Applicability Layer is pure logic, and the conditional-expansion call reuses the already-validated Claude Code adapter.

---

## 4. Affected files

**New:**
- `data/registry-export.json` — the manually-captured registry snapshot (real data, confirmed live in Section 0), one entry per Content ID, verbatim field values.
- `scripts/sync-registry.ts` — reads the export, canonicalizes region values, writes the runtime cache with a `syncedAt` stamp.
- `data/registry-cache.json` — the generated, canonicalized cache `lib/` code actually reads at runtime (never the export directly — matches "ingestion never talks to the sheet, only the cache").
- `lib/applicability/index.ts` — the Applicability Layer: `filterEligible()` (hard gate), `labelApplicability()` (soft, per-result labeling), `requiresClarification()` (deterministic trigger).
- `lib/applicability/regionCanonicalization.ts` — the region/country lookup table and normalization function.
- `lib/runtime/queryExpansion.ts` — the conditional multilingual expansion mechanism (sufficiency check, expansion call, merge/re-rank, graceful fallback).
- `tests/applicability.test.ts` — new, deterministic tests (no live CLI): eligibility gate, region matching, clarification trigger, canonicalization.
- `tests/queryExpansion.test.ts` — new, deterministic tests: sufficiency-check logic and fallback behavior (not the live expansion call itself, consistent with the existing test suite's "never calls the live Claude CLI" boundary).

**Modified:**
- `lib/ingestion/chunk.ts` — `Chunk` gains `region: string[]`, `audience: string[]`, `aiEligibility`, `contentStatus`; `chunkDocument()` accepts governance data to attach.
- `lib/ingestion/ingest.ts` — loads the registry cache once, looks up each document's governance record by Content ID, passes it through to `chunkDocument()`; DOCX-extracted region/audience become the fallback only when the registry cache has no entry for that ID.
- `lib/runtime/knowledgeBase.ts` — applies `filterEligible()` before `buildIndex()`; exposes eligible/excluded counts for logging.
- `lib/retrieval/index.ts` — unchanged mechanically (still pure BM25); receives a pre-filtered chunk set rather than filtering itself, keeping governance logic out of the retrieval module entirely.
- `lib/runtime/promptBuilder.ts` — labeled context blocks; new mode-selection and mode-specific behavior instructions; the hard clarification instruction when triggered; accepts the Applicability Layer's output as structured input rather than embedding any governance logic itself.
- `lib/runtime/citationBuilder.ts` — `formatCitation()` includes the region/audience/status label.
- `lib/runtime/turnKind.ts` — extended to parse a second trailing tag (`planningMode`) alongside the existing `turnKind` tag, with the same safety guarantees already validated for the first tag (never leaks, never breaks on absence/malformation, neutral default).
- `lib/runtime/interactionLog.ts` — `schemaVersion: 2`, `planningMode`, `applicabilityFlag`, `metadataSyncedAt`, richer `sources[]` (region/eligibility per source) — purely additive, old records remain valid, matching `docs/logging-foundation.md`'s own backward-compatibility rule.
- `app/api/chat/route.ts` and `scripts/ask.ts` — both wired identically (matching the existing "no duplicated business logic" convention): eligibility-gated index, labeling, clarification gate, conditional expansion, mode-aware prompt, extended logging.
- `app/page.tsx` (citation rendering only) — displays the region/audience label alongside each citation; no new business logic in the frontend, matching `Architecture.md` Section 14's boundary.
- `tests/ingestion.test.ts`, `tests/retrieval.test.ts`, `tests/citation.test.ts` — updated expectations for the new `Chunk` fields, plus a new hard-pass/fail assertion that `RKC-000021` never appears in the built index under any query.

**Unchanged, explicitly:** `lib/ingestion/docx.ts`, `lib/ingestion/normalize.ts`'s citation-URL logic, `lib/runtime/sessionState.ts`, `lib/runtime/sessionRegistry.ts`, `lib/runtime/reasoningEngine.claudeCode.ts`, all of `app/layout.tsx`/`app/globals.css`, `package.json` (no new dependencies).

---

## 5. Business Assistance — the construction-latitude boundary, precisely

This is the mechanism most load-bearing for validation scenarios 2–4, so it's worth stating exactly rather than gesturally:

- **Knowledge Retrieval mode**: unchanged from today — every substantive claim must trace to a specific retrieved passage.
- **Knowledge Synthesis mode**: claims still trace to retrieved knowledge; may be combined, reorganized, and summarized across multiple sources into one coherent answer.
- **Business Assistance mode**: Hubi constructs the requested artifact (pitch, email, discovery questions, objection handling, meeting prep, summary, communication) using grounded facts as verified inputs. Structure, tone, framing, and general communication/sales craft *not* sourced from the knowledge base are permitted (e.g., "open with rapport, close with a clear next step" is generic craft, not a Wellhub fact). **Any specific factual claim about Wellhub, pricing, process, or the business must still trace to retrieved knowledge, with zero exception.** When constructing an artifact would naturally call for a fact that isn't grounded (e.g., a burnout-reduction statistic), the correct behavior is to decline *that specific claim* while continuing to help with the rest of the artifact — not to refuse the whole request, and not to invent the number. This is the precise fix for the Turn 2/Turn 3 friction observed in the original test conversation.

The system prompt changes needed to implement this (mode-selection instruction, three behavior blocks, the strengthened claim-level boundary, the extended tag format) are part of implementation, not drafted here — this section specifies their required behavior so it can be reviewed and approved before that prompt text is written.

---

## 6. Architecture Traceability

| Implementation piece | Architectural principle(s) it satisfies |
|---|---|
| Eligibility hard-gate before index-building | *"AI Eligibility is mandatory"*; *"Governance always precedes reasoning"*; *"The Registry governs applicability, not factual accuracy"* |
| Content Status hard-gate (Draft/Deprecated/Archived excluded) | *"Content Status is mandatory"* |
| Registry cache as the single metadata source; no duplicated governance logic | This milestone's own explicit instruction; *"Hubi consumes governance; it does not create it"* |
| `region`/`audience` propagated to `Chunk`, registry-sourced | *"Global applicability is a claim, not a default"*; foundational input the Applicability Layer requires to exist at all |
| Region canonicalization | *"Governance decisions should be deterministic wherever possible"* |
| Applicability labeling in prompt + citations | *"Traceability is how trust is earned, not asserted"*; *"Language is not applicability"* |
| Deterministic clarification-required trigger | *"Clarification is preferable to confident but incorrect answers"*; *"Applicability always precedes reasoning"*; directly closes Finding #002 |
| Conditional multilingual expansion, gated on a free sufficiency check | *"Cost and latency are product constraints"*; *"Hubi retrieves broadly but answers narrowly"*; multilingual retrieval philosophy (`Product_Architecture.md` Section 6) |
| Task Planning V0 (3-mode self-classification, folded into the existing single call) | Deepens Request Classification, per `docs/task-planning-architecture.md` Section 4; avoids the cost/latency risk flagged in that same document's Section 6 |
| Task Planning has zero code path into retrieval or eligibility | *"Task Planning never expands what knowledge Hubi may use — only changes how Hubi uses already-approved knowledge"* (this milestone's own explicit constraint, and the hard invariant from all three architecture-review rounds) |
| Business Assistance's claim-level grounding boundary | *"Hubi must never invent facts"*; *"Every factual claim must remain grounded"*; the Grounded Assistance concept from `docs/task-planning-architecture.md` |
| Construction latitude never overrides the clarification gate | *"Governance always precedes reasoning"* holds identically regardless of mode — the clarification gate runs before mode-specific construction, not after |
| `planningMode` / `applicabilityFlag` / `metadataSyncedAt` in logs | *"Traceability"*; this milestone's own stated goal of *"preserving clear observability"* so retrieval/planning/reasoning failures can be told apart; the Knowledge Intelligence loop (`Product_Architecture.md` Section 1) |
| No new runtime dependency | The standing constraint that no UI library, embeddings, or vector DB is introduced without first proving the metadata-driven approach insufficient |

---

## 7. Validation Plan

**Commands:** `npm test` (regression suite) plus targeted live runs via `node --experimental-strip-types scripts/ask.ts "<question>"` for each scenario below (matching how every prior finding in this project has been validated — live pipeline runs, not just unit tests).

1. **Original onboarding meetings question** (*"I have a new Enterprise client in Mexico. Which onboarding meetings do I need to run?"*): expect the sufficiency check to fail on the raw query (as measured in the Finding #003 investigation), conditional expansion to trigger, `RKC-000006` (Spanish) to surface via the expanded query, its region label to show `SS Latam` with `Mexico` recognized as a canonicalized match (not a mismatch), and mode to classify as Knowledge Retrieval.
2. **Original elevator pitch, Turn 1**: mode classifies as Business Assistance; retrieval unchanged (this already worked); expect a constructed pitch without the defensive up-front hedging observed in the original transcript.
3. **Tailoring for Financial Enterprise, Turn 2**: the specific previously-broken case — expect Hubi to now actually construct an industry-tailored version (framing/structure latitude) rather than declining, while still not inventing any Wellhub-specific "financial industry" fact that isn't grounded.
4. **Tailoring for burnout, Turn 3**: expect a constructed, tailored opening using the grounded "engagement" pillar and the grounded ~60%-didn't-have-a-gym-before stat, while explicitly declining any specific burnout-reduction statistic that isn't grounded — confirming latitude applies to framing, never to invented facts.
5. **Region-specific onboarding** (Finding #002's live-reproduced Spanish query, *"¿Cuál es el proceso de onboarding del cliente en mi región?"*, no region stated): expect the deterministic clarification gate to fire (all top results region-specific, no Global fallback, no region term in the conversation) and Hubi to ask for the region *before* answering — the direct regression test for the Critical-severity failure already confirmed live once.
6. **Multilingual retrieval**: re-run Finding #001's original query and Finding #002's cross-language scenarios (English question about a Brazil process; Portuguese question about the Global Salesloft topic); expect conditional expansion to recover the correct-language content where the direct query previously failed.
7. **Safe refusal when information genuinely doesn't exist**: re-run the nonsense-query test and the EU-competitors test from `Prototype_Plan.md` Appendix C/D — must still refuse correctly; additionally, confirm `RKC-000021` is never retrievable or citable under any query (hard pass/fail, Finding #003's own stated success criterion) and that `RKC-000012` always renders with its restriction caveat when it does surface.
8. **Existing regression suite remains green**: all 13 current tests plus the new applicability/query-expansion tests pass under `npm test`.

**Regression scenarios carried forward, not re-derived** (per `docs/context-applicability-architecture.md` Section 12 and `Prototype_Plan.md` Appendix C/D): session continuity, clarifying-question behavior for non-region context (the T3/T4 contract-tier scenario), citation rendering (clickable/non-clickable), and the sufficiency-check-passes case showing zero added latency (confirms the conditional gate genuinely skips expansion when not needed).

---

## 8. What I'm asking you to approve

The scope boundary in Section 1, the six flagged defaults in Section 2 (any of which can be changed before code is written), the affected-files list in Section 4, and the Business Assistance behavior boundary in Section 5. Nothing in `lib/`, `app/`, `scripts/`, `tests/`, or `data/` has been created or changed yet.
