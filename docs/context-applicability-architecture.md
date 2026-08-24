# Context, Applicability, and Multilingual Retrieval Architecture

**Status: design proposal, not yet implemented.** Consolidates and supersedes the narrower Finding #002 implementation plan. Nothing here should be implemented until reviewed.

---

## 1. Current-State Assessment

Today, Hubi's retrieval and reasoning have no concept of content governance, applicability, or business/task context. Every DOCX in `Content Repository` is ingested unconditionally. Region/audience metadata exists at the document level (from each DOCX's own "Document Metadata" table) but is discarded before reaching the `Chunk` objects retrieval actually operates on. There is no language field, no client-segment/tier field, and no permission/access-level concept anywhere. The only safeguard against a wrong-region answer is a free-text instruction asking the model to use judgment — confirmed insufficient by a live test in Finding #002.

## 2. Findings From the Actual Metadata Sheet

Access to the linked Google Sheet (`RKC | Revenue Knowledge Center - Content Registry`) was verified directly — not assumed. It is a governance registry, structurally richer than anything currently modeled in Hubi. Key structure (from its own Data Dictionary tab):

| Field | Notes |
|---|---|
| Content ID | Permanent, neutral identifier — the correct join key to Hubi's `doc.id` (title matching is not reliable; registry and local titles differ slightly for the same asset, e.g. `Opportunity Best Practices - Direct channel BR` vs. our local `Opportunity Best Practices - BR`) |
| Taxonomy L1 / L2 | Matches what we already extract |
| **Language** (multi-select, required) | Its own stated governance intent is "drives regional content filtering" — **this is the exact anti-pattern Product has directed Hubi to avoid.** Hubi's design deliberately diverges from the registry's own stated intent for this field: Language and Region/Country are treated as fully independent dimensions in Hubi, regardless of how the registry describes its own purpose for the field. |
| **Region / Country** (multi-select, required) | The canonical region source. Its own governance rule: *"Use 'Global' only when content is truly globally applicable without regional variation."* Real values observed: `Global`, `United States`, `Brazil`, `Europe`, `SS Latam` (sampled). **"Europe" is a real, present value** — the Spain/Europe scenario Product raised is not hypothetical; `RKC-000015` and `RKC-000016` (CS/Sales coaching sessions, currently ingested) are tagged `United States, Europe`. |
| Audience (multi-select) | Matches what we already extract, though registry values are more granular than our local DOCX field in some cases |
| Revenue Journey Stage (multi-select) | Lifecycle stage — Discovery / Renewal / Expansion / Closing / Implementation / Onboarding / Cross-journey / Internal Operations. Directly usable as the vocabulary for "Business/Task Context → lifecycleStage" (Section 4), no need to invent a new taxonomy. |
| Access Level | Revenue – All / Revenue – Specific Function / Revenue – Leaders Only / Internal Wellhub / Restricted-Confidential / External-Client-facing. **Maps directly to future permission-gated retrieval** — the natural anchor for IAM compatibility. |
| Client-shareable | Yes / No / Partially / Unknown |
| **Priority Tier** (P1 – Revenue Driver / P2 – Growth Accelerator / P3 – Value Enhancer) | **A content-governance review-priority concept — not the same thing as client segment/tier (T0–T4).** This naming collision must be avoided explicitly in Hubi's own schema (never call the client-facing concept just "tier"). |
| Content Status | Draft / Active / Under Review / Update Required / Deprecated / Archived |
| **AI Eligibility** (required) | Eligible / Eligible with Restrictions / Pending Assessment / Not Eligible. *"Assets marked 'Not Eligible' or 'Pending Assessment' will be excluded from AI retrieval until cleared."* |
| Issues / Risks (multi-select) | Includes flags like "Incomplete Content", "Conflicting Information", "Sensitive Information" |

**A real, urgent governance gap found live:** `RKC-000021` ("RKO 2026: What is Wellhub — Elevator Pitch Submission") is tagged **`AI Eligibility: Not Eligible`** in the canonical registry, yet it is one of the 15 documents Hubi currently ingests, indexes, retrieves, and can answer from *today*. This is an active compliance gap, independent of and more urgent than the region-canonicalization work. `RKC-000012` is tagged **`Eligible with Restrictions`** with an **`Incomplete Content`** risk flag — also currently unrespected.

**No client-segment/tier metadata exists anywhere** — not in the registry, not in local DOCX metadata. Where segment/tier is discussed (e.g. `RKC-000020`), it's the document's subject matter, not applicability metadata about the document. If Product wants content filtered by client segment/tier the way region will be, that requires new metadata design from scratch — it isn't sitting unused the way region was.

**Two metadata sources use different vocabularies for the same thing:** local DOCX "Target Region" fields use informal shorthand (`SS Latam`, `US, SS-Latam`); the canonical registry uses fuller forms (`SS Latam`, `United States, SS Latam`). Canonicalization must reconcile *both* sources, not just clean up one.

**Citation URLs remain a DOCX concern, not a registry concern** — the registry's `Original Source URL` is the same admin-style WorkRamp link already extracted from the DOCX; there is no distinct rep-facing Learner URL column in the registry. The already-validated citation-URL logic (`lib/ingestion/normalize.ts`) is unaffected by this proposal.

**Scale:** the registry contains far more assets (partial direct sampling found roughly 80 rows before parsing complexity limited further extraction, against our local 15-document export) than Hubi's current Content Repository — confirming any sync design must be built for a catalog larger than today's, not just today's 15.

**A technical caveat on this investigation itself:** the Drive text-export tool used to read the sheet renders free-text cells (e.g. long "Supporting Files Folder Link" notes) with embedded characters that collide with the row-delimiter, making some rows unreliable to parse from this export format alone. The findings above are directly verified for our 15 documents and are a good-faith sample for the wider registry, not a full census. **A production sync should use the Sheets API's structured cell data, not this text-export format**, to avoid this fragility — flagged as an open technical prerequisite, not a blocker for the design.

## 3. Proposed Context Model

Three distinct layers, matching Product's direction that user context and task context are not interchangeable:

**User Context** — who is asking, set once per session (V0), later from IAM:
`userRegion`, `roleOrTeam`, `habitualSegment` (a hint, not authoritative), `preferredLanguage`, and — in a future version — `accessScope` (mapping to the registry's own `Access Level` vocabulary).

**Business/Task Context** — what the question is actually about, dynamic, per-conversation:
`taskRegion`, `clientTier` (deliberately never called just "tier" in code, to avoid collision with content governance's Priority Tier), `product`, `lifecycleStage` (reusing the registry's own Revenue Journey Stage vocabulary directly), `globalVsLocalDeal`, `operationalProcess`.

**Conversation Context** — what's been explicitly said or clarified this session. Today's `Session`/`Turn`/`accumulatedUserQuery` mechanism already captures this as raw text; the addition needed is capturing **structured slot-fills** alongside it (e.g. once a user says "Tier 1 in Brazil," that populates `taskRegion=Brazil` as a structured value, not just more retrieval text).

### Precedence rules
1. Explicit Conversation Context (this turn or earlier this session) always wins.
2. Business/Task Context, once known, always takes precedence over User Context defaults for anything client- or task-specific — matching Product's direction exactly.
3. User Context may be used only as: a **default** when nothing task-specific is known and the question isn't clearly about a different client/region; a **personalization signal** (e.g. `preferredLanguage` affects rendering style, never regional applicability); or a **clarification shortcut** (Hubi may suggest the user's own region as one option when asking, never assume it).
4. User Context must never silently substitute for an explicit or inferable Task Context.
5. When retrieved content is region-(or segment-)specific and neither Conversation Context nor a safe default resolves it, Hubi must ask — never guess, never silently apply User Context as if it were Task Context.

**Safe defaults:** `preferredLanguage` (rendering only). **Requires clarification:** `taskRegion`/`clientTier` whenever retrieved content is specific and unresolved. **Conflicting context:** most recent explicit statement wins; Hubi acknowledges the change rather than silently blending old and new. **Future IAM:** IAM can supply User Context fields (who the user is) but can never supply Task Context (what deal/client is being discussed right now) — this is the one hard boundary that must survive into any future identity system.

## 4. Applicability Layer

A new conceptual layer between Context (Section 3) and answer generation, with three decision types kept explicitly distinct:

- **Metadata-based, deterministic** (no LLM, no ambiguity): exclude `AI Eligibility = Not Eligible` or `Pending Assessment` outright — a hard gate, never a ranking signal. Exclude inactive `Content Status` (Draft/Deprecated/Archived). Treat `Global` region as always eligible. Match multi-region arrays against a known task region. Compute, deterministically, whether a mandatory clarifying-question trigger applies (region-specific-only results + unknown/non-matching task region).
- **Retrieval relevance** (BM25 + conditional multilingual expansion, still no LLM): ranks only within the already-eligible set.
- **LLM reasoning** (Claude Code, given labeled context): synthesizes from preferred/eligible sources, asks when the Applicability Layer says it must, and handles sub-region nuance that lives only in prose (e.g. RKC-000006's internal AR/MX split — metadata can't resolve this at any granularity tested, and this remains an acknowledged limitation, not solved by this proposal).

This split is the core mechanism for minimizing "confident but operationally incorrect" answers: the single highest-stakes decision — *should I even attempt to answer, or must I ask first* — becomes deterministic, not a matter of the model's own judgment or self-report.

Effect on the pipeline: retrieval only ever searches the eligible set; reranking is soft (labels, not hard pre-filtering, since task region often isn't known until mid-conversation); prompt construction labels every source with its canonical region/audience and applicability status explicitly; **citations now display this label too** — closing the gap where today a human reviewing sources has no way to catch a wrong-region citation either.

## 5. Metadata Synchronization Design

**Recommended: an explicit, on-demand sync step, not ingestion-time fetching.** Ingestion stays fully offline-safe (matching the existing zero-dependency philosophy) by always reading from a local, versioned cache; a separate sync command refreshes that cache from the registry when run.

- **Manual synchronization (recommended for V0):** an explicit command reads the registry, canonicalizes region values, and writes a local cache file stamped with `syncedAt` (and the sheet's own `modifiedTime`, already available from Drive metadata). Simple, fully controllable, no scheduling infrastructure.
- **Ingestion-time synchronization:** rejected as the default — it would make every local ingestion run (including the offline terminal tool and tests) depend on Google API/network availability. Acceptable only as an opt-in flag (`--sync`) layered on top of the manual approach, never the default path.
- **Scheduled synchronization:** explicitly deferred to a future version, per Product's own framing.
- **Behavior when the sheet is unavailable:** unaffected in the common case, by design — ingestion never talks to the sheet directly, only the cache. If no sync has ever run, behavior degrades to today's DOCX-only metadata, not a failure.
- **Freshness/traceability:** every interaction log record carries the `metadataSyncedAt` timestamp active at the time of that retrieval (see Section 8), so any historical interaction can be tied back to the exact governance snapshot used.
- **Source-of-truth boundaries:** the registry is canonical for AI Eligibility, Content Status, Access Level, Client-shareable, Priority Tier, Region/Country, Audience, Language, Revenue Journey Stage. The local DOCX remains canonical for the actual chunkable text and for citation URL selection (Learner vs. admin URL) — the registry doesn't carry that distinction.

## 6. Conditional Multilingual Retrieval Flow

1. Run retrieval on the **original** question, over the **eligible set only**.
2. Assess sufficiency — a cheap, deterministic, non-LLM check: top score above an empirically-set threshold **and** the top result's applicability is not "incompatible" (Global or task-region-matched, or region genuinely unresolved-but-Global). Both must hold.
3. If sufficient → answer directly. **Zero added latency or cost** — this is the common case Product's own pricing-question example describes.
4. If insufficient (weak/empty results, or the only matches are region-incompatible) → expand.
5. Languages to expand into come from the **synced corpus metadata's own Language field** (currently English, Portuguese, Spanish) — not hardcoded, so it stays correct as the corpus grows.
6. Expand/translate the query, re-run retrieval over the same eligible set, same applicability labeling — expansion changes *which terms are searched*, never *which region a chunk represents*, keeping the two mechanisms structurally independent as required.

**Translation adapter — options compared, no dependency selected without this trade-off:**

| Option | Quality on Revenue jargon | New dependency | Cost/latency | Replaceable |
|---|---|---|---|---|
| Local translation library | Likely poor — generic translators don't know "Magic Link," product names, proper nouns, and may mangle them | Yes — a new library | None per call | Yes, but a worse starting point |
| Dedicated translation API (Google Translate, DeepL, etc.) | Better general quality, same jargon risk unless a custom glossary is configured (extra setup) | **Yes — new paid dependency** | Added network call every time it triggers | Yes |
| **Claude Code, called conditionally (recommended)** | Best — already Wellhub/Revenue-context-aware, instructable to leave proper nouns untranslated | **None — reuses the existing, isolated, already-validated adapter** | One extra round-trip, **only on the minority of queries that fail step 2** | Yes — same adapter interface |

Recommendation: conditional Claude Code expansion. It's the only option that adds zero new dependencies and is inherently "only when necessary" by construction, directly addressing the stated cost concern (shared Claude usage across projects).

**Caching:** expansion results can be cached by normalized query text for a session (or lightly across sessions) — cheap to add, not essential given expected V0 volume.

**Fallback if translation is unavailable:** fall back to the original-language retrieval results already computed in step 1 — never a hard failure, matching the existing "fail safely" adapter philosophy.

## 7. Cost and Latency Considerations

The Applicability Layer and canonicalization work are pure local computation — effectively free. The entire cost/latency delta of this whole proposal reduces to one controllable question: **how often does conditional expansion actually trigger?** Because it's gated on a free, deterministic check, that frequency is boundable and observable (the log's `applicabilityFlag`/expansion-triggered field would let Product see this directly once testing starts).

## 8. Logging Implications

Extends `docs/logging-foundation.md` rather than replacing it:

- **Identity context:** none in V0 (no accounts); reserved for future IAM.
- **User context:** the already-proposed `session_context` record, with `region` constrained to the same canonical vocabulary as synced content metadata (joinable later).
- **Business/task context — new:** per-interaction fields for whatever task-context slots were resolved this turn (`taskRegion`, `clientTier`, `product`, `lifecycleStage`, `globalVsLocalDeal`) — distinct from user context, since these can differ within one session.
- **Conversation context:** structured slot-fills captured alongside existing turn history, not just raw text.
- **Retrieval evidence:** as previously proposed, now with each candidate tagged with its applicability classification and canonical region/AI-eligibility at retrieval time.
- **Applicability decisions — new:** did the Applicability Layer trigger a mandatory clarifying question; was Global content used; was incompatible content excluded — a structured, auditable record of Section 4's own decisions.
- **Answer outcome:** existing `turnKind` self-report, now one signal among several rather than the only one.
- **Feedback:** unchanged.
- **Manual Knowledge Demand classification — new:** the previously-proposed `manual_review` event type now uses a structured `knowledgeDemandType` enum (process clarification / missing documentation / deck request / calculator or tool request / template request / custom material request / training opportunity / fragmented-or-conflicting information / system-tool support) instead of free text alone — Knowledge Demand as the umbrella concept, not "training need" for everything.
- **Metadata version:** every interaction record carries `metadataSyncedAt`.

## 9. Future IAM and Personalization Compatibility

`contextSource` (`session_setup` | `IAM` | `manually_reviewed`) already anticipates User Context being populated automatically from IAM without a schema break. The registry's own `Access Level` field is the natural anchor for future permission-gated retrieval. The hard boundary that must be preserved regardless of how sophisticated identity gets: **IAM can supply User Context; it can never supply Task Context.** Behavior/recommendation history (a later personalization layer) stays a distinct concept from both, built on top of the logging foundation once there's enough real data to warrant it — not proposed now.

## 10. Smallest V0 Implementation Boundary

1. Manual sync script (registry → canonicalized local cache, `syncedAt` stamped).
2. `Chunk` extended with canonical `region: string[]`, `audience`, `aiEligibility`, `contentStatus`, sourced from the cache.
3. Applicability Layer module: deterministic eligibility/exclusion, Global-always-eligible, multi-region matching, mandatory-clarification trigger.
4. Labeled applicability context in the prompt + strengthened instruction; citations display the label too.
5. Conditional multilingual expansion (free sufficiency check → conditional Claude Code call → graceful fallback).
6. Session-level User Context intake + per-turn Business/Task Context slot capture, feeding both the Applicability Layer and the logging schema.

**Explicitly not in scope:** embeddings/vector DB (not demonstrated necessary), scheduled sync, full IAM integration (schema hooks only), any dashboard, sub-region (within-document) granularity.

## 11. Success Criteria

- `RKC-000021` (Not Eligible) is never retrievable or citable, under any query — hard pass/fail.
- Region-specific-only content with unknown/non-matching task region always triggers a clarifying question before any process description.
- Global content continues answering directly with no unnecessary clarifying questions.
- A strong-Global-match query (the pricing example) completes with zero added reasoning-engine calls.
- Citations visibly display region/applicability.
- Every interaction log record carries `metadataSyncedAt`.

## 12. Regression Scenarios

All previously-identified scenarios (Finding #001 original query; Finding #002's four scenarios; multi-region document handling; existing Runtime Core behaviors: session continuity, clarifying question, citations, safe refusal) **plus**:
- `RKC-000021` never surfaces, regardless of query.
- `RKC-000012` (Eligible with Restrictions + Incomplete Content) — exact expected handling is an open decision (Section 13).
- A Europe-region query against non-Europe-tagged content triggers the same safeguard as the Brazil/SS-Latam cases (now a real, confirmed-present scenario, not hypothetical).
- Sufficiency-check-passes case shows zero added latency (verifies the conditional gate actually skips expansion).
- Sufficiency-check-fails + expansion-call-fails shows graceful fallback, never a crash or silent wrong answer.
- Ingestion with a stale or missing sync cache degrades gracefully to DOCX-only metadata.

## 13. Open Product Decisions

1. Exact required handling for `Eligible with Restrictions` content — usable-with-caveat, or requires clarification too?
2. Whether to bundle `Content Status` filtering (exclude Draft/Deprecated/Archived) into this same fix — same mechanism, similarly urgent, found real examples in the sampled data, but not explicitly among the six required elements.
3. Whether to invest in Sheets-API-based parsing now (more robust) versus a defensive text-export parser as a first pass, given the fragility found during this investigation.
4. Sequencing of Access-Level-based permission enforcement — meaningful only once real identity exists; partial in V0.
5. Ownership of the region-canonicalization mapping table — engineering-owned in code, or governance-owned as an explicit registry field?
6. Whether `habitualSegment` (User Context) is worth collecting in V0 at all, given no content-side segment/tier metadata exists anywhere yet to use it against.
