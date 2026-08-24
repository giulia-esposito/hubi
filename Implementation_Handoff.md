# Hubi — Implementation Handoff

**Purpose of this document:** let a new Claude conversation continue the Hubi project without access to this conversation's history. This is not an architecture review — it's a status snapshot. For full reasoning behind any decision below, follow the file references; this document deliberately does not repeat their content.

---

## 1. Product Status

Hubi is Wellhub Revenue's AI Copilot: an internal prototype that answers Revenue questions grounded in the real Revenue Knowledge Center content, with visible citations, multi-turn continuity within a session, and honest refusal when it lacks grounded knowledge.

**Current maturity:** a working local prototype, validated through internal engineering investigation — **not yet through real Revenue rep testing.** It has a functioning Web UI and a terminal tool, both wired to the same real 602-chunk knowledge base and the same Claude Code reasoning engine. It also has an extensively developed **conceptual architecture** — Product Architecture, and a dedicated Conversation Continuity design — that is **ahead of the actual implementation** in several real, specific ways detailed in Section 5 and Section 6. Treat conceptual completeness and code completeness as two different axes; this project currently has more of the former than the latter.

**One fact should shape how the next milestone is chosen:** a confirmed, **Critical-severity** product risk (Finding #002, `docs/validation-findings.md`) was explicitly rated by Product as *"must be addressed before moderated Revenue rep testing"* — and it is not yet fixed in code. See Section 8.

---

## 2. Existing Canonical Documents

**Canonical conceptual references** — the standing architecture. Should not be redesigned without a genuine, concrete contradiction found in practice:
- **`Product_Architecture.md`** — the primary conceptual reference. Product vision, principles, core vocabulary (Knowledge Governance, Applicability Layer, Context layers, Knowledge Intelligence), and how Hubi relates to the Knowledge Center Content Registry.
- **`Architecture.md`** — the target Runtime/technical architecture: Conversation Orchestrator, Request Classification, Context Builder, Knowledge Engine, Retrieval Layer, Reasoning Engine adapter, response rendering, and the three-role knowledge-repository model (Google Drive / WorkRamp / local Content Repository). Includes the confirmed Web UI/API boundary (Section 14.1) and the current security posture (Section 17.1/17.2).
- **`Conversation_Continuity_Architecture.md`** — dedicated conceptual architecture for resuming prior work across sessions/channels. **Fully designed, zero code implemented.** See Section 5/6/7.
- **`CLAUDE.md`** — stable product philosophy and engineering principles (org-level, changes slowly).
- **`Product.md`** — product requirements.

**Operational / implementation-state documents** — describe what actually exists right now, and change often:
- **`Prototype_Plan.md`** — current-state-first record of what's implemented and confirmed, with full validation history preserved in Appendices A–E. The most reliable single source for "what actually works today," alongside this document.
- **`README.md`** — practical setup/run/test instructions.
- **`docs/handoff.md`** — a narrower, code-focused technical handoff ("how to run and understand the prototype," file map, specific gotchas found while building the Web UI). This document (`Implementation_Handoff.md`) is broader and conversation-level; `docs/handoff.md` is the file-by-file engineering reference. Both are current; neither replaces the other.
- **`docs/testing-guide.md`** — for internal reviewers and Revenue reps taking part in testing.
- **`Current_sprint.md`** — sprint scope and definition of done. **Likely stale** — written before the Web UI, the validation findings, and both conceptual architecture documents existed. Treat it as historical framing, not current scope, until it's refreshed.

**Live tracking / in-progress governance record:**
- **`docs/validation-findings.md`** — the append-only log of product validation findings. Contains two fully investigated, Product-reviewed findings (#001 cross-language retrieval, #002 regional applicability) with decisions already recorded. This is where the next milestone's justification lives.

**Engineering proposals — designed, approved in principle, NOT implemented:**
- **`docs/context-applicability-architecture.md`** — the Context, Applicability, and Multilingual Retrieval Architecture. Directly answers Findings #001/#002. Its "smallest V0 implementation boundary" (Section 10) is the strongest candidate for the next milestone. **No part of this has been built.**
- **`docs/logging-foundation.md`** — proposed richer logging schema (schema versioning, session context, applicability flags, Knowledge Demand taxonomy). **Not implemented** — the current log schema is still the original simple one (see Section 5).

---

## 3. Non-Negotiable Architectural Principles

Consolidated from `Product_Architecture.md` and `Conversation_Continuity_Architecture.md`. One line each; follow the source documents for full reasoning.

**Knowledge and governance:**
- The Knowledge Center Content Registry is the single source of truth for official business knowledge; Hubi consumes governance, it never creates or overrides it.
- Governance always precedes reasoning — AI reasoning only operates on knowledge already filtered for eligibility and applicability.
- Governance decisions should be deterministic wherever metadata makes that possible, not left to model inference or self-report.
- Global applicability is a claim that must be explicit, never a default assumed from absence of a stated region.
- The Registry governs applicability, not factual accuracy — content correctness remains the business owner/SME's accountability.
- Language is not applicability — the language a question is asked in says nothing about which region's content applies.
- Hubi retrieves broadly but answers narrowly — wide candidate search, narrowly-scoped final answer.
- Clarification is preferable to a confident but incorrect answer.
- Traceability is how trust is earned, not asserted.
- Cost and latency are product constraints — AI capabilities with real per-use cost are invoked only when needed, not by default.
- Every interaction is a knowledge signal — the basis for Hubi's Knowledge Intelligence feedback loop back to the Knowledge Center.

**Context and conversation:**
- User Context is not Business/Task Context — who is asking is a different fact from what the question is about.
- Business Context always overrides default User Context whenever they conflict.
- Conversation history is never a source of business facts — including in Conversation Continuity.
- Semantic or topical similarity alone never authorizes conversation reuse — **compatibility, not similarity, authorizes continuity.**
- Context compatibility is evaluated as independent, optional Context Scopes (identity, business entity, initiative, task, temporal) — not a mandatory hierarchy. Only scopes that actually exist for a conversation participate.
- Explicit context always outranks inferred context.
- Continuity is seamless within an active context, transparent when resuming previous work after a real gap, and explicit only when genuine uncertainty exists.
- Different clients or business entities must remain isolated — a business context is never automatically inherited across that boundary, no matter how similar the topic.
- Uploaded documents may support analysis of the current case; they never create unsupported business facts.
- Web App and Google Chat share one conceptual Conversation Store; the difference is experience, not data.
- Google Chat must not depend on user-managed threads — conversation boundaries are Hubi's decision, not the channel's.

---

## 4. Decisions Already Made

Do not reopen these.

- Google Chat identity uses the authenticated Google Workspace identity. Web App authentication mechanism is **still undecided** (the one real implementation blocker for Conversation Continuity — see Section 7).
- Business context is normally established once, explicitly, by the user; Hubi may infer it afterward from conversation or uploaded documents. When inferred confidence is insufficient, Hubi asks rather than assumes.
- Conversation history is private to each user by default.
- Exactly **one** authorized Hubi administrator has backoffice visibility initially (troubleshooting, quality review, adoption analysis, product improvement, knowledge-gap identification). No impersonation. Expanding beyond one admin is deferred.
- Conversation history never becomes organizational knowledge automatically — a real gap travels through the Knowledge Intelligence loop to a human governance decision instead.
- Conversation history is retained indefinitely for the initial product-learning phase; retention policy may evolve later.
- Elapsed time reduces continuity confidence but never by itself determines whether continuity is appropriate, and never overrides explicit user intent.
- "Open in Hubi" is deferred beyond V1 — not part of the current interaction model.
- User-defined folders are the Web App's organizing model; no predefined workspace types.
- Start Fresh is an explicit escape hatch, not the normal interaction model — automatic continuity is the default.
- Only Next.js and React (plus `react-markdown`/`remark-gfm` for response rendering) are approved as runtime dependencies — no UI component library, no Tailwind, no embeddings/vector database introduced without first demonstrating the metadata-driven approach can't meet the required behavior.
- The Web UI is local-only, bound to `127.0.0.1`, for internal team and moderated rep testing (screen-share/remote-control to one machine) — not independently reachable from reps' own devices during this phase.

---

## 5. Current Implementation

Grounded directly in the repository as it exists now — nothing here is aspirational.

**Ingestion** (`lib/ingestion/`): DOCX-only, zero npm dependencies (DOCX parsed as a ZIP of XML via Node's built-in `zlib`). Extracts the house template's Document Metadata table (including `targetRegion`, `targetAudience`) at the **document** level into `NormalizedDocument.metadata`. Confirmed: 15/15 real documents, 602 chunks, 0 failures, reproducible.

**Retrieval** (`lib/retrieval/index.ts`): pure lexical BM25 — tokenize, lowercase, strip punctuation, drop stopwords, score. **No stemming. No cross-language matching. No region/eligibility awareness of any kind.** This is exactly the retrieval layer Findings #001 and #002 diagnosed; nothing about it has changed since those findings were recorded.

**A specific, confirmed gap:** `Chunk` (`lib/ingestion/chunk.ts`) carries only `id, documentId, documentTitle, heading, text, citationUrl, citationUrlType`. Region and audience are extracted at the document level but **never propagated to the chunk level** — confirmed by direct inspection, unchanged since Finding #002.

**Runtime** (`lib/runtime/`): `sessionState.ts` (in-memory `Session`/`Turn`, `accumulatedUserQuery`), `sessionRegistry.ts` (server-side `Map<sessionId, Session>`, no eviction), `knowledgeBase.ts` (lazy ingest-once-per-process singleton), `promptBuilder.ts` (grounded prompt + `HUBI_SYSTEM_PROMPT`, including the turn-kind self-tagging instruction and an explicit "you don't know who is asking" rule), `reasoningEngine.claudeCode.ts` (spawns `claude` CLI, Phase-0-confirmed isolation flags, real token streaming), `turnKind.ts` (strips the model's self-report tag; never leaks it; degrades to neutral on absence/malformation), `citationBuilder.ts`, `interactionLog.ts`.

**Logging** — the **original, simple schema only.** `logs/interactions.jsonl` currently records `{type, timestamp, sessionId, interactionId, question, response, sources, turnKind, latencyMs, ok}` for interactions and `{type, timestamp, sessionId, interactionId, helpful, comment?}` for feedback. **No `schemaVersion`, no `session_context` record type, no applicability flags, no Knowledge Demand taxonomy** — all of that is designed in `docs/logging-foundation.md` but not built.

**Web UI** (`app/`): a one-screen Next.js/React chat interface. Real NDJSON streaming from `app/api/chat/route.ts` (Node.js runtime, spawns the Reasoning Engine, applies retrieval + prompt building, logs the interaction). `app/api/feedback/route.ts` logs Helpful/Not-helpful + optional comment. Session identity is a **random UUID stored in `sessionStorage`** — anonymous, per-browser-session only, discarded when the session ends. Assistant responses render as real Markdown via `react-markdown` + `remark-gfm` (headings, bold/italic, lists, tables, blockquotes, code blocks, links with `target="_blank" rel="noopener noreferrer"`); raw HTML in model output is never parsed (no `rehype-raw`), which is the actual XSS boundary. Visual states for clarifying-question and no-grounded-answer turns are distinct and confirmed working. A permanent "internal prototype" banner is always visible.

**Terminal tool** (`scripts/ask.ts`): single-question or interactive multi-turn REPL, sharing every runtime module the Web UI uses.

**Tests** (`tests/`, 13 tests, `npm test`): ingestion correctness against the real corpus, BM25 mechanics + real-corpus retrieval + gap handling, citation formatting. Deliberately never calls the live Claude CLI — fast, deterministic, offline.

**Not implemented anywhere in code:** the Applicability Layer, metadata synchronization with the Google Sheet Content Registry, region/audience canonicalization, AI Eligibility/Content Status governance filtering, conditional multilingual query expansion, Conversation Continuity (Conversation Store, Conversation Resolution, Context Scopes), and any persistent/authenticated user identity.

---

## 6. Known Product and Implementation Problems

- **Overly long, low-confidence answers that provide little value** (reported observation). Not yet formally root-caused the way Findings #001/#002 were — a real candidate for investigation, and plausibly related to the retrieval gaps below (weak retrieval can force verbose hedging).
- **Insufficient retrieval / failure to find the most relevant document** — **confirmed and root-caused** (Findings #001, #002): a pure lexical, non-stemmed, single-language-blind BM25 index cannot reliably find cross-language or region-mismatched content, even when it exists in the corpus. Fix designed (`docs/context-applicability-architecture.md`), not implemented.
- **Clarifying questions are not always concise** — directly observed during Finding #002 live testing: Hubi sometimes delivers a full explanation before asking the one question it actually needs answered.
- **No retrieval retry/expansion when the first pass is weak** — the conditional multilingual expansion flow is fully designed (`docs/context-applicability-architecture.md` Section 6) but not implemented; today's retrieval is always exactly one lexical pass.
- **No persistent, authenticated user identity in the Web App** — confirmed by design; sessions are anonymous and disappear when the browser session ends. This is the named blocker for Conversation Continuity in the Web App specifically (Google Chat's identity question is already resolved).
- **Conversation Continuity is architected but not implemented** — zero code exists for the Conversation Store, Conversation Resolution, or Context Scopes.
- **A live governance gap**: `RKC-000021` is tagged `AI Eligibility: Not Eligible` in the canonical Registry but is still ingested, retrievable, and answerable by Hubi today — no eligibility filtering has been built yet. This is arguably the single most urgent, concrete item on this list.
- **Region/audience metadata is discarded between document and chunk level** — confirmed gap, see Section 5.
- **No stemming in the tokenizer** — a contributing factor in Finding #001, still present.
- **No session eviction** in `sessionRegistry.ts` — acceptable for short local test windows, not for sustained use.
- `Current_sprint.md` is stale relative to actual progress (a documentation gap, not a code gap).
- Minor, accepted, not blocking: a transitive `postcss`/`sharp` advisory inside Next.js's own build tooling (build-time only, non-deployed app); one unreproduced cosmetic streaming artifact (a missing space in one response, traced and ruled out as a pipeline bug).

---

## 7. Open Decisions

**Implementation blockers:**
- Web App authentication mechanism — blocks Conversation Continuity in the Web App specifically. Does **not** block retrieval/governance/answer-quality work, which has no identity dependency.

**Can be deferred (already explicitly deferred in the canonical documents):**
- Backoffice access beyond the single initial administrator.
- External system (CRM-style) integration as a source for Context Scope values.
- "Open in Hubi."
- Retention policy evolution beyond "indefinite for now."
- Exact handling for Registry content marked "Eligible with Restrictions" (usable-with-caveat vs. requires-clarification-too) — a real open decision from `docs/context-applicability-architecture.md`, but engineering can begin with a conservative default and confirm this along the way rather than waiting on it.
- Whether to bundle Content Status filtering with AI Eligibility filtering in the same effort — recommended to bundle (same class of gate), but not a hard prerequisite to starting.
- Ownership of the region-canonicalization mapping (engineering-maintained vs. a governance-owned Registry field).
- Whether to invest in Sheets-API-based parsing now vs. a defensive first pass, given real parsing fragility found during direct inspection of the Registry.

**Need validation through real user testing, not further architecture work:**
- Whether "long, low-confidence answers" is primarily a retrieval problem, a prompt-verbosity problem, or both.
- Whether clarifying-question conciseness is worth prioritizing on its own, once retrieval is improved.
- Real-world tuning of retrieval "sufficiency" thresholds for triggering conditional multilingual expansion.

---

## 8. Recommended Next Milestone

**Implement the smallest V0 boundary from `docs/context-applicability-architecture.md` (its own Section 10):** propagate existing region/audience metadata to the chunk level, add the AI Eligibility / Content Status governance gate, add a minimal Applicability Layer, add labeled applicability context to the prompt, and add conditional multilingual query expansion (Claude Code, called only when a cheap sufficiency check fails — no new paid dependency, no embeddings).

**Why this, and not Web App identity or Conversation Continuity:** Conversation Continuity is a large, cross-cutting new capability that is *blocked* on an undecided identity mechanism and has no stated urgency. The retrieval/governance work, by contrast, is fully designed, already approved in principle (including the explicit "no embeddings unless proven necessary" constraint), requires no identity decision, and directly fixes a risk Product has already rated **Critical — must be addressed before moderated Revenue rep testing.** Starting anywhere else means shipping rep testing against a known, rated-critical gap.

**Why this likely also helps answer quality:** weak or wrong retrieval plausibly explains some of the reported "long, low-confidence answer" problem — Hubi hedges at length when what it's been handed doesn't actually answer the question. This milestone doesn't need to solve verbosity directly to make real progress on it as a side effect; if it doesn't, that becomes a well-scoped, cleanly separable follow-up.

**Sequencing within the milestone, if it needs to be split further:** the AI Eligibility/Content Status governance gate is the cheapest, most urgent slice and could ship alone first if time is tight; region/chunk propagation and the Applicability Layer are the next slice; conditional multilingual expansion is the natural fast-follow after that, since it's the most latency/cost-sensitive piece and benefits from being tuned against real usage.

**Explicitly not this milestone:** Web App identity, Conversation Continuity, embeddings/vector search, any logging schema migration beyond what this milestone's own applicability decisions need to record.

---

## 9. Suggested First Prompt for the New Conversation

```
I'm continuing the Hubi project in a new conversation. Before doing anything else:

1. Read Implementation_Handoff.md in full.
2. Read the repository's current state: the canonical architecture documents
   (Product_Architecture.md, Architecture.md, Conversation_Continuity_Architecture.md),
   the current implementation record (Prototype_Plan.md), and the actual code
   under lib/, app/, scripts/, and tests/.
3. Confirm your understanding of Hubi's current product status, the
   non-negotiable architectural principles, and the decisions already made
   (Implementation_Handoff.md Sections 1, 3, 4) before proposing anything.
4. State the exact recommended next milestone from Implementation_Handoff.md
   Section 8, and wait for my explicit approval before starting any work.
5. Once approved, produce a concrete implementation plan for that milestone --
   scope, files affected, success criteria, and regression scenarios --
   before changing any code.
6. Preserve the established conceptual architecture exactly as documented.
   Do not redesign or contradict Product_Architecture.md, Architecture.md, or
   Conversation_Continuity_Architecture.md unless you discover a genuine,
   concrete contradiction between the documented architecture and what's
   actually in the repository -- if so, stop and flag it explicitly rather
   than silently deciding a fix yourself.
7. Do not implement anything until I approve the plan.
```
