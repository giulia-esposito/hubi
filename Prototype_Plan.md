# Hubi — Prototype Implementation Reference

## Document purpose

This document describes the **current implementation state** of the Hubi local prototype: what's built, what's confirmed working, what's known-limited, and what's next. It is maintained current-state-first — read top to bottom for "what is true right now."

The full validation and correction history — how each conclusion was reached, including mistakes found and fixed along the way — is preserved in full in the Appendices, not deleted. If you want the narrative of *how* something was validated, it's there. If you want to know *what's true right now*, you shouldn't need to read it.

For product vision and stable architecture, see [`CLAUDE.md`](CLAUDE.md), [`Product.md`](Product.md), [`Architecture.md`](Architecture.md). For this sprint's scope, see [`Current_sprint.md`](Current_sprint.md). For how to run the prototype, see [`README.md`](README.md).

---

## 1. Current State at a Glance

| Area | Status |
|---|---|
| Reasoning Engine (Claude Code) | **CONFIRMED** — Phase 0 passed, authenticated, `stream` mode selected |
| Knowledge ingestion | **CONFIRMED** — DOCX only, 15/15 real documents, 602 chunks, 0 failures |
| Retrieval | **CONFIRMED** — BM25 lexical index, no embeddings |
| Runtime Core (session, prompt builder, citations) | **CONFIRMED** — multi-turn terminal pipeline validated |
| Automated regression suite | **CONFIRMED** — 13 tests passing, `npm test` |
| Web UI | **CONFIRMED** — one-screen Next.js prototype, real streaming, citations, feedback, local logging (Section 14) |
| PDF / PPTX / TXT / Markdown ingestion | **NOT IMPLEMENTED** — not needed for current demo scope |
| Request Classification / Context Builder as separate components | **NOT BUILT** — deliberately deferred; clarifying-question behavior is currently achieved via the Reasoning Engine's own instructed judgment, not a separate classifier (Section 7) |
| Rep testing (screen-share/remote-control on the local machine) | **NOT STARTED** — next milestone, after internal team validation |

---

## 2. Scope & Stack

One Web Application (not yet built), the 9-component Hubi Runtime, all four interaction types on one shared code path, sources, related materials, suggested next step. No auth, no accounts, no persistence beyond the active local session, no deployment. Runs locally for a presenter-led walkthrough — not left running for stakeholders afterward, not installed elsewhere.

**Stack:** one Next.js (TypeScript) app (UI not yet built). No separate backend, no database, no vector store/embeddings. Retrieval is local lexical + metadata. Session state is in-memory, scoped to the active process.

---

## 3. Reasoning Engine — Claude Code (CONFIRMED)

Claude Code is the validated Reasoning Engine, confirmed end-to-end on the target machine, authenticated. Full validation narrative: **Appendix A**.

- **Invocation:** `claude -p "<prompt>" --output-format stream-json --include-partial-messages --verbose --system-prompt "<...>" --tools "" --strict-mcp-config --setting-sources ""`.
- **Isolation:** the three flags above produce the CLI's own `init` event reporting `tools:[]` and `mcp_servers:[]` — this is the technical proof of isolation the codebase relies on, not a self-report from the model. (An earlier draft of this document mistakenly listed a `--safe-mode` flag; confirmed not to exist in the installed CLI version — v2.1.160 — and removed.)
- **Streaming:** real incremental token streaming confirmed working (`reasoningEngineMode: "stream"`). A bug in the validation script itself initially reported the opposite conclusion; found and fixed — see Appendix A.
- **Multi-turn:** Hubi's own Session State re-sends conversation history as explicit prompt text every turn (`lib/runtime/promptBuilder.ts` + `lib/runtime/sessionState.ts`) rather than relying on Claude Code's own session/resume mechanism, keeping the Reasoning Engine adapter swappable.
- **Latency:** two smoke-level samples measured 8.07s–8.5s full-response completion; first-token arrival observed around 1.5–2.2s in raw streaming events. A proper p50/p95 profile with real prompt sizes has not yet been measured — planned, not done.
- **Error/timeout handling:** confirmed clean non-zero exit on an invalid model, confirmed timeout kill on an artificially short wall clock.
- **Adapter interface:** `ReasoningEngine.generate(preparedPrompt, conversationContext): Response`, implemented today by `lib/runtime/reasoningEngine.claudeCode.ts`. Swapping to a direct Anthropic API, Gemini, or Vertex AI later means writing a new implementation of the same interface — nothing else in the Runtime changes.

To (re-)run Phase 0 validation: `npm run validate-phase0` (Node) or `npm run validate-phase0:windows` (native PowerShell, no Node required). See `README.md`.

---

## 4. Knowledge Ingestion (CONFIRMED — DOCX only)

- **DOCX: implemented and validated** against the real Content Repository — 15/15 documents, 602 chunks, 0 parse failures, reproduced directly on the target machine (not just in a dev sandbox). Zero npm dependencies: the DOCX reader is built directly on Node's built-in `zlib`/XML handling (a DOCX is a ZIP of XML), not a third-party library like `mammoth` — deliberate, both because an earlier dev sandbox couldn't reach the npm registry and because it's one fewer dependency for the most load-bearing part of the pipeline.
- **PDF: not yet implemented.**
- **PPTX: not yet implemented.**
- **TXT: not yet implemented.**
- **Markdown: not yet implemented.**

The real Content Repository (20 asset folders) has 15 DOCX-containing folders and 5 video-only folders with no extractable text in v1 (no OCR/transcription in scope) — these are simply not ingested, not an error. Several DOCX folders also contain supplementary images/videos alongside the document; these aren't parsed, and would become "related materials" pointers in a later milestone, not raw media ingestion.

All 15 real documents follow a consistent house template: Heading 1 (title), Heading 2 "1. Document Metadata" (a structured field table), Heading 2 "Core Knowledge Body" (the chunkable content). The parser looks for this template by name and falls back to generic heading/paragraph/table detection if a future document doesn't use it.

Known real data-quality findings in the source documents themselves (not parsing bugs):
- `RKC-000018` has no populated Learner URL, so its citation falls back to the WorkRamp admin URL.
- `RKC-000014`'s Learner URL field itself contains an admin-style URL — a copy-paste inconsistency in that specific source document.
- `RKC-000016` has no populated title heading; its display title falls back to its filename.

**Architecture** (`lib/ingestion/`): `zip.ts`, `docx.ts`, `normalize.ts`, `chunk.ts`, `ingest.ts`. Chunking rule: each Section (a DOCX heading block) is a candidate chunk; sections over ~220 words are split further along word boundaries, and every resulting chunk keeps its parent section's heading as its citation locator.

Adding a non-DOCX parser later means writing one new parser function behind the same dispatch interface — not a re-architecture. Per current product direction, this is only worth doing if a non-DOCX source becomes necessary for an agreed demo, not proactively.

Full build history and evidence: **Appendix B**.

---

## 5. Retrieval (CONFIRMED — lexical BM25, no embeddings)

`lib/retrieval/index.ts` — zero-dependency in-memory BM25 index over `Chunk[]`:
- Tokenizes, lowercases, strips punctuation, drops stopwords.
- Heading text is folded into the indexed tokens twice as a cheap relevance boost for heading matches (no separate scoring path needed).
- Standard BM25 scoring (k1=1.5, b=0.75); returns top-K scored chunks with locators.
- No embeddings, no vector database, per the architecture's stated approach for this stage.

Metadata filtering (region/audience) and conflict precedence (source-of-truth > freshness > audience/region match > formal-over-informal) are described in `Architecture.md` but not yet implemented in the retrieval layer — with today's 15-document, single-repository corpus, there's limited real conflict to arbitrate yet. Revisit once metadata-driven filtering becomes demo-relevant.

**Known limitation:** pure lexical retrieval is measurably weaker on long, unstructured single-heading documents (verbatim video transcripts with no internal subheadings, e.g. `RKC-000008`) than on documents with real heading structure — a single coincidental word match across a very long transcript block can produce a nonzero score for an otherwise unrelated query. Confirmed via testing (Appendix C), not hypothetical. Did not cause an incorrect answer in testing because the Reasoning Engine's own grounding instruction caught it, but retrieval precision on transcript-heavy documents is genuinely weaker. Not fixed yet — candidates for later: a minimum relevance threshold, or chunking transcripts by speaker turn/timestamp rather than only word count.

---

## 6. Runtime Core (CONFIRMED — most recent milestone)

Scope was deliberately kept narrow, per explicit product direction: validate session continuity, context reuse, clarifying questions, grounded citations, and safe refusal — without building a general request-classification framework.

- **`lib/runtime/sessionState.ts`** — in-memory `Session` (an ordered list of user/assistant `Turn`s), scoped to the active process only (`Architecture.md` Section 12: no persistence, no cross-session memory required at this stage). `accumulatedUserQuery()` concatenates every user message so far as the retrieval query for the current turn — not just the latest message — so a clarifying-question exchange (e.g. "what contract model for my client" → "they finalized as T3") keeps retrieving relevant content on the follow-up turn without a separate intent/context classifier.
- **`lib/runtime/promptBuilder.ts`** — extended to accept prior conversation turns and prepend a "Conversation so far" block, re-sent as plain text every turn (the Phase-0-validated approach), so Claude Code's own understanding of the conversation is always explicit and Hubi's Session State stays the single source of truth.
- **No separate Context Builder or Request Classification component was built.** The ability to ask a clarifying question when business context is genuinely required is currently achieved entirely through the Reasoning Engine's own instructed judgment (`HUBI_SYSTEM_PROMPT`: "if answering well depends on business context you don't have... ask a clarifying question instead of assuming"), validated against a real scenario (Appendix D). Per the approved milestone scope, a classifier will only be introduced if testing proves this insufficient — it has not, so far.
- **`scripts/ask.ts`** — the terminal entry point, now session-aware: every question is answered in the context of the full conversation so far, not in isolation.

**Two real bugs were found and fixed during validation**, both in the REPL harness itself, not the Runtime logic:
1. The original REPL used chained `rl.question()` calls, which silently drops any input already buffered in stdin once the stream reaches EOF mid-turn. This affected piped/scripted testing directly, and could plausibly affect a real interactive user who sends a message while a ~10–20s response is still streaming.
2. Switching to the `'line'` event fixed the drop, but revealed a worse issue: with fast/burst input, two turns could start concurrently, and their live-streamed output interleaved character-by-character on stdout. Fixed with an explicit processing queue (`queue` + `processing` flag in `scripts/ask.ts`) that guarantees one turn fully completes before the next starts, regardless of how fast input events fire.

Full narrative and transcripts: **Appendix D**. Validated behaviors:
1. Session continuity across turns.
2. Appropriate reuse of prior context (accumulated retrieval query).
3. Clarifying question asked when business context is genuinely required (real scenario: contract model depends on the client's final tier).
4. Grounded answers with citations, preserved across turns.
5. Safe refusal when the knowledge base doesn't support an answer, preserved even with retrieval noise carried over from earlier turns in the same session.

---

## 7. Citations (CONFIRMED)

Every chunk carries a locator from ingestion through retrieval to the final response (`lib/runtime/citationBuilder.ts`). Presence of a link controls clickability, never whether a citation is shown:
- If a URL is available: a clickable reference (document + heading locator).
- If not: the same locator, displayed but not clickable.

**Which URL is correct is now explicit** (previously an open question, since resolved by the Product Owner — see `Architecture.md` Section 6 for the full three-role model):
- **WorkRamp-originated training content** (all 15 real documents currently in the Content Repository) → cite the **Learner URL** (the rep-facing link), never the admin URL.
- Content native to Google Drive (not yet present in the real corpus, but architecturally supported) → cite the Google Drive URL.
- The local `Content Repository` folder is a temporary development copy only — never the citation target, never the source of truth.

Implemented in `lib/ingestion/normalize.ts` (citation URL selection logic) and `lib/runtime/citationBuilder.ts` (rendering).

---

## 8. Repository Structure (current, accurate)

```
Hubi/
  app/
    page.tsx                       The one conversational screen (client component)
    layout.tsx                      Root layout + prototype banner
    globals.css                     Plain CSS, no UI library
    api/
      chat/route.ts                   Streams one turn as NDJSON (Node.js runtime, not Edge)
      feedback/route.ts               Logs Helpful/Not-helpful feedback
  lib/
    ingestion/
      zip.ts            DOCX-as-ZIP reader (zero-dependency)
      docx.ts            Raw paragraph/table block extraction
      normalize.ts        House-template-aware metadata + section extraction, citation URL selection
      chunk.ts            Section -> retrieval-sized Chunk splitting
      ingest.ts           ingestContentRepository() -- walks + dispatches + reports
    retrieval/
      index.ts            BM25 index: buildIndex(), search(), tokenize()
    runtime/
      sessionState.ts      In-memory conversation Session / Turn
      sessionRegistry.ts    Server-side Map<sessionId, Session> for the web UI
      knowledgeBase.ts      Lazy singleton: ingest + build index once per server process
      promptBuilder.ts      Grounded prompt + HUBI_SYSTEM_PROMPT, with conversation history + self-tagging instruction
      reasoningEngine.claudeCode.ts   Claude Code adapter: spawns claude, streams live, isolation flags
      turnKind.ts           Strips the model's trailing self-report tag; never leaks it; neutral default
      citationBuilder.ts    formatCitation() (terminal tool; the web UI renders the same rule as JSX directly)
      interactionLog.ts     Appends JSONL records to logs/interactions.jsonl
  scripts/
    ask.ts                       Terminal entry point (single question or interactive multi-turn REPL)
    test-ingestion.ts            Ingestion report CLI
    validate-phase0.mjs          Phase 0 validation (Node)
    validate-phase0.ps1          Phase 0 validation (native PowerShell, no Node required)
    dev.cmd                       Dev-server launch wrapper (sets PATH for the portable Node runtime)
  tests/                         Automated regression suite (node:test) -- ingestion, retrieval, citations
  docs/
    testing-guide.md              For internal reviewers and Revenue reps
    handoff.md                    For another engineer
  logs/                           interactions.jsonl -- local, inspectable, gitignored
  Content Repository/            Local development copy of the real Revenue Knowledge Center export (DOCX)
  package.json                   Scripts; next/react/react-dom are the only runtime dependencies
  README.md                      Setup and run instructions
  Prototype_Plan.md               This document
  Architecture.md / Product.md / Current_sprint.md / CLAUDE.md
```

Not yet built (planned, per `Architecture.md`'s target layering, not yet needed for the current milestone): `conversationOrchestrator.ts`, `requestClassifier.ts`, `contextBuilder.ts` as a distinct component, `knowledgeEngine.ts` conflict-precedence logic, `responseRenderer.ts` as a distinct component (currently inlined into `app/page.tsx`).

---

## 9. Known Limitations (consolidated)

1. **Transcript retrieval weakness** — see Section 5. Not fixed; flagged for later.
2. **Accumulated-query retrieval can carry noise across turns** — a long multi-turn session can surface earlier-topic chunks alongside the current question's real matches (observed in testing, Section 6/Appendix D). The Reasoning Engine's own grounding instruction currently absorbs this; no relevance decay or windowing has been built.
3. **No automated test exercises the live Claude Code CLI** — the regression suite (Section 10) is deliberately deterministic/offline; reasoning-engine behavior is validated via Phase 0 and manual scenario testing, not CI-style automation.
4. **Latency is only smoke-tested**, not profiled (Section 3).
5. **No PDF/PPTX/TXT/MD ingestion** — by product decision, not a gap to close reactively.
6. **No persistence** — conversation state and the retrieval index are rebuilt from scratch on every server process start.
7. **`turnKind` is a model self-report, not independent classification** — accepted prototype debt (Section 14, Appendix E). Degrades safely (never breaks the response, never leaks the tag, defaults to neutral), but can mis-tag; rep testing is expected to surface this if it happens in practice.
8. **No session eviction in the web UI's server-side session registry** — an in-memory `Map`, fine for a short local test window, would need addressing before any long-running or multi-day use.
9. **A transitive `postcss` security advisory ships inside Next.js's own build tooling** — fixing it means downgrading Next.js to v9 (`npm audit fix --force`); not worth it for a build-time-only issue in a non-deployed local app. Monitored, not fixed.

---

## 10. Automated Regression Suite

`npm test` runs `tests/*.test.ts` via Node's built-in test runner (zero test-framework dependency, consistent with the rest of the codebase). Currently 13 tests across 4 suites:
- **Ingestion** (`tests/ingestion.test.ts`): exact document/chunk counts against the real corpus, house-template usage, required chunk fields, a known document's exact chunk count.
- **Retrieval** (`tests/retrieval.test.ts`): BM25 mechanics against a synthetic fixture (tokenizer, ranking, zero-match), plus an integration test against the real corpus for a known-answer question and for safe gap handling (fabricated non-words, chosen to avoid the Section 5 transcript-collision limitation).
- **Citations** (`tests/citation.test.ts`): clickable/non-clickable rendering, heading-present/absent locator variants.

**Deliberate scope boundary:** none of these call the live `claude` CLI. That keeps the suite fast, deterministic, and independent of auth/network/API cost — appropriate for a suite that should run often and reliably. The Reasoning Engine's actual behavior (streaming, isolation, multi-turn, clarifying questions) is validated via `scripts/validate-phase0.*` and the manual scenario transcripts in Appendix D, not by this suite. If this project moves toward CI, whether/how to add live-CLI coverage is a decision point (external dependency and cost trade-off) worth flagging rather than silently automating.

---

## 11. Engineering Roadmap

Phase 0 (Reasoning Engine validation) and Phase 1 (ingestion + retrieval) are complete. The originally-planned linear Phase 2→3→4 sequence was revised by product direction into a narrower, risk-reducing path:

- ~~Phase 2 — Runtime core~~ → delivered as a milestone (Section 6), scoped narrower than originally planned (no separate classifier component).
- ~~Phase 3 — Reasoning + grounded response~~ → delivered as part of the vertical slice (Appendix C) and the Runtime Core milestone.
- ~~Phase 4 — Web UI~~ → delivered (Section 14): one-screen Next.js prototype wrapping the validated pipeline, real streaming, citations, clarifying-question/no-answer visual states, feedback, local logging.
- **Next: internal team validation, then moderated Revenue rep testing** — see `docs/testing-guide.md` for the test model. No further engineering milestone is proposed until this testing produces findings to act on.
- **Deferred, revisit only if testing or the demo needs it:** PDF/PPTX/TXT/MD parsers, metadata-based retrieval filtering, conflict precedence logic, Google Chat interface, production/cloud architecture, a real `turnKind` classifier to replace model self-tagging (all described at the target-architecture level in `Architecture.md`, none required for the current prototype).

---

## 12. Demo Preparation Notes

**Where complexity is deliberately being pushed back on:**
- No parser plugin framework — one shared interface with a small dispatch on file extension is enough for the known formats; a registry/plugin system would solve a problem that doesn't exist yet.
- No OCR, no image/diagram understanding — explicitly excluded for PDF/PPTX; flagging low-text content is sufficient for a prototype.
- No cross-document conflict UI beyond what `Architecture.md` already asks for — with the current single-repository corpus, this logic exists in principle but isn't demo-visible yet.
- No persistent ingestion database — a content-hash check against files already on disk would be enough to make "add a file, refresh" fast; a real ingestion pipeline with job queues etc. is production scope.

**Demo rehearsal principles (once a UI exists):**
- Reliable startup: one command starts the app; the ingestion report is checked first, every time, before the room sees anything.
- Predictable scenarios: a rehearsed, known-good walkthrough; live improvisation possible but not load-bearing.
- Graceful failure: a Claude Code error or timeout mid-demo shows a clear, calm message and a retry action — never a stack trace, never a silent hang.
- Grounding is visible: every substantive answer shows its citation, so "grounded in your actual knowledge base" is demonstrable, not just claimed.

**Candidate demo conversation templates** (to finalize with real content once the demo scope is set):
1. **Direct Question** — a factual/definitional question the training directly answers. Tests: clean grounded answer + visible citation.
2. **Business Scenario** — a situation requiring contextual guidance. Tests: a relevant clarifying question, then a grounded, structured response.
3. **Decision Support** — a question where the training documents trade-offs but doesn't prescribe one answer. Tests: documented options presented, decision left to the user.
4. **Process Guidance** — a documented process. Tests: ordered steps, sourced, no invented steps.
5. **Multi-turn continuity** — a natural follow-up without restating prior context. Tests: session state actually used. **Confirmed working** — Appendix D.
6. **Safe handling of a gap** — a plausible-sounding question the training doesn't cover. Tests: Hubi clearly saying it doesn't have grounded information. **Confirmed working** — Appendix C and D.

Real examples already validated for templates 5 and 6 exist in Appendix C/D and can be reused directly in a demo script.

---

## 13. Product Decisions Log

- **Citation link rule (decided):** WorkRamp-originated content → Learner URL. Google Drive-native content → Google Drive URL. Implemented in `lib/ingestion/normalize.ts`. Superseded an earlier open question about Drive-only URLs.
- **Video handling (decided):** ignore video/image files entirely — confirmed correct by inspection, since real transcripts are already embedded as text in the DOCX Core Knowledge Body (Appendix B.3). Related Materials will mean other topically-relevant ingested documents, not raw media files.
- **Repository roles (decided):** Google Drive is the canonical Hubi knowledge repository; WorkRamp is the learning source and citation destination for training assets; the local Content Repository is a temporary prototype development copy only. See `Architecture.md` Section 6/7.
- **Runtime baseline (decided):** the portable Node.js ZIP distribution is the development baseline on this machine until IT provides a managed install (Appendix B.6).
- **Working model (decided):** Product Owner (Giulia) / Lead Engineer (Claude) split. Documentation is a deliverable, not a follow-up activity.
- **Access model for testing (decided):** Hubi is reachable only via `127.0.0.1` on the machine it runs on. Internal team testing, then moderated rep testing via screen-share/remote-control to that same machine — reps do not reach it from their own devices during this phase. No auth/access-control work is in scope until that changes. See `Architecture.md` Section 17.1.
- **`turnKind` self-tagging (decided, accepted debt):** clarifying-question/no-answer visual states come from Claude Code's own trailing self-report tag, not a classifier. Approved explicitly as intentional prototype debt, with required safeguards (never leak the tag, never break on a missing/malformed tag, default neutral). See Section 14 and Appendix E.
- **Only Next.js/React as new runtime dependencies (decided):** no UI component library, no Tailwind — plain CSS, to keep the dependency surface at exactly what was approved.

---

## 14. Web UI (CONFIRMED)

A one-screen Next.js prototype wraps the previously-validated pipeline for internal and moderated rep testing. Full validation narrative and every bug found: **Appendix E**.

- **`app/page.tsx`** — the single conversational screen (client component). Renders the message list, a fixed composer, a permanent "internal prototype" banner (in `app/layout.tsx`), and per-message citations/feedback controls. Contains no business logic — it only renders what the API sends and forwards user actions.
- **`app/api/chat/route.ts`** — a thin Route Handler (Node.js runtime, not Edge) wrapping the exact same `lib/ingestion`/`lib/retrieval`/`lib/runtime` modules the terminal tool uses. Streams one turn as NDJSON: a `retrieval` event (chunk count + sources), then one `delta` event per real incremental token from Claude Code, then one `done` event (ok/error, latency, `turnKind`, `interactionId`).
- **`app/api/feedback/route.ts`** — logs a Helpful/Not-helpful record, optionally with a short comment, correlated to the original interaction by id.
- **`lib/runtime/knowledgeBase.ts`** — ingestion + index-building now happen once per server process (a lazy singleton), not once per request, which is the one real behavioral difference from the terminal tool's per-invocation ingestion.
- **`lib/runtime/sessionRegistry.ts`** — server-side `Map<sessionId, Session>`, keyed by a browser-generated id stored in `sessionStorage` (continuity within the current browser session only, per approved UX scope; no eviction, see Section 9).
- **`lib/runtime/turnKind.ts`** — parses Hubi's own trailing self-report tag (`[[HUBI:GROUNDED_ANSWER]]` / `CLARIFYING_QUESTION` / `NO_GROUNDED_ANSWER`, appended per an instruction added to `HUBI_SYSTEM_PROMPT`) to drive the UI's visual treatment, and strips it before the user or the log ever sees it. This is model self-report, not classification — explicitly approved as prototype debt, with required safeguards confirmed working: a missing tag, or one with an unrecognized keyword, never breaks the response and always renders neutrally; the tag itself is never visible, live-streaming included (a small trailing character holdback keeps it off-screen even mid-stream, not just in the final render).
- **`lib/runtime/interactionLog.ts`** — appends one JSONL record per interaction and one per feedback submission to `logs/interactions.jsonl`, correlated by `interactionId`. No personal data beyond a random session UUID.

### 14.1 Access model — CONFIRMED

`next dev`/`next start` are explicitly bound to `--hostname 127.0.0.1` (see `package.json`). This was not the framework default — see Appendix E for how that was caught. Internal team testing and moderated rep testing (screen-share/remote-control to the same local machine) are both compatible with this access model without any further work; independent rep access from other devices is explicitly out of scope until revisited.

### 14.2 What was deliberately not built

No authentication, no Google Chat, no Google Drive sync, no production analytics, no user profiles, no cross-browser-session history, no suggested prompts/homepage polish, no related-material recommendations, no admin interface, no request classification, no production deployment — all per approved scope.

*Preserved verbatim from the original working session. Reflects the actual chronology, including a documentation error found and corrected (a nonexistent `--safe-mode` flag) and a real streaming-detection bug found and fixed mid-validation.*

### A.0 Important execution constraints discovered while starting Phase 0

Two separate constraints surfaced once work moved to the real machine, both now resolved in how Phase 0 is run:

- **No Node.js on this machine, and no admin rights to install it.** The original validation script (`scripts/validate-phase0.mjs`) required `node`. Node.js is not installed here and cannot be installed without administrator privileges. Since `claude.exe` itself is a standalone binary with no Node dependency, Phase 0 does not actually need Node — only the original validation script's implementation did. **Resolution:** `scripts/validate-phase0.ps1` reimplements the identical 7 checks using only native PowerShell (already present, no install/admin required) and the `claude` CLI. This is now the primary way to run Phase 0 on this machine. The `.mjs` version is kept as-is for any environment that does have Node — same checks, same `phase0-result.json` shape, either script produces a comparable result.
- **Authentication must happen on your machine.** Confirmed via `claude auth status` → `"loggedIn": false, "authMethod": "none"`. Every authenticated check (real streamed tokens, real latency, real multi-turn continuity) requires your own Claude Code login and can only be run once you complete `claude auth login` (or `claude setup-token`) locally.

### A.1 Non-interactive invocation

Mechanism: `claude -p "<prompt>" --output-format stream-json --include-partial-messages --verbose`. `--print` (`-p`) is the documented non-interactive mode; `--verbose` is required whenever `--output-format stream-json` is used (the CLI errors otherwise — confirmed by testing).

### A.2 Preventing Claude from independently accessing files or tools

Verified available flags that directly satisfy this requirement:

- `--tools ""` — disables every built-in tool (Read, Bash, Edit, WebFetch, etc.). **Primary evidence: the CLI's own `init` event reports `"tools":[]`** when this flag is passed — this is the technical proof of isolation, checked programmatically by the validation script (`checks.streamingAndIsolation.toolsEmpty`).
- `--strict-mcp-config` (with no `--mcp-config` supplied) — guarantees no MCP servers are attached. **Primary evidence: the same `init` event reports `"mcp_servers":[]`** (`checks.streamingAndIsolation.mcpEmpty`).
- `--setting-sources ""` — prevents the CLI from auto-loading any project `CLAUDE.md`, skills, plugins, or hooks from the machine it runs on. Confirmed present in `claude --help` on the installed CLI (v2.1.160).
- `--system-prompt` (full override) — the adapter supplies its own minimal system prompt rather than letting Claude Code's default system prompt leak into the reasoning context.

**Correction:** an earlier draft of this section also listed `--safe-mode` as a required isolation flag. Checked directly against `claude --help` on the actual installed CLI (v2.1.160) — **`--safe-mode` does not exist in this version.** It was removed from the isolation arguments used by both validation scripts and from this list. Isolation is fully achieved by the three flags above.

The validation script also asks Claude directly whether it can access files (`checks.noFileAccessSanityCheck`) — kept as a **secondary sanity check only**. It is Claude's own self-report, not technical proof, and must never be described as evidence of isolation on its own. The `init` event's `tools:[]` / `mcp_servers:[]` is the actual proof.

### A.3 Output format and real token streaming

**Real incremental streaming is confirmed working.** A raw authenticated `stream-json` call for a 5-sentence prompt produced 2 distinct `content_block_delta` events (`"This"`, then `" is one. This is two. This is three. This is four. This is five."`) before the final `assistant`/`result` events — genuine incremental delivery, not a single-shot dump.

**A real bug was found and fixed while validating this:** the first automated run of the validation script concluded `realStreamingObserved: false` (recommending the fallback) — but that conclusion was wrong, caused by a bug in the script itself, not in Claude Code. The script's event parser read the streaming delta text from a top-level `.delta.text` field, but the actual CLI schema nests it one level deeper, under `.event.delta.text` (a `stream_event` envelope wraps the real Anthropic streaming event). That path mismatch silently returned `null` for every incremental chunk, making it look like nothing streamed. Fixed in both `scripts/validate-phase0.ps1` and `scripts/validate-phase0.mjs`; re-running after the fix correctly detects 3 distinct text snapshots and reports `realStreamingObserved: true`. This directly reversed the streaming-mode decision — exactly the kind of tooling bug that would have caused Hubi to ship the *wrong* rendering mode if not caught before building the reasoning engine adapter.

### A.4 Decision: real streaming selected (not the fallback)

`reasoningEngineMode: "stream"` — recorded in `scripts/phase0-result.json`. The progressive-reveal fallback remains documented as a contingency (e.g. if a different auth mode or network condition behaves differently on some future machine), but it is **not** the mode the Reasoning Engine adapter builds against by default.

If real streaming ever needs to be disabled (flaky chunks, buffering that defeats the purpose), the fallback is a **progressive-reveal rendering**, not real streaming: call Claude once in `--print --output-format json` mode, wait for the complete response, and render it client-side at a natural reading pace. This is visually similar to streaming but is **not token-level streaming** — the model has already finished generating before any text appears. The adapter reports which mode is active so this distinction is never blurred.

### A.5 Response stability, latency, multi-turn context, error/timeout handling

- **Latency:** 2 representative prompts measured end-to-end (full process completion, not first-token): 8.07s and 8.50s. This is *full-response* latency, not time-to-first-token — the raw streaming event log separately showed the first content arriving around 1.5–2.2s (`ttft_ms`).
- **Multi-turn context:** the explicit re-sent-context approach passed — turn 2 correctly answered "4271" when the full turn-1 exchange was re-sent as prompt text, confirming Hubi's own Session State (not Claude Code's session file) is a viable source of truth for conversation history.
- **Error/timeout handling:** an invalid `--model` value produced a clean non-zero exit with `is_error: true` (no hang, no crash). An artificially short 1.5s wall-clock timeout correctly killed the child process rather than blocking.

### A.6 Model abstraction

The adapter interface stays `ReasoningEngine.generate(preparedPrompt, conversationContext): Response`, implemented today by a `ClaudeCodeReasoningEngine`. Swapping to a direct Anthropic API, Gemini, or Vertex AI later means writing a new implementation of the same interface — nothing else in the Runtime changes.

### A.7 The Phase 0 validation script

Runs 7 checks against a real, logged-in Claude Code install, then writes `scripts/phase0-result.json` with pass/fail per check, measured latencies, and a recorded decision (`"reasoningEngineMode": "stream"` or `"progressive-reveal-fallback"`) — that write-out is the script's final action, not an 8th check.

1. Confirms `claude` is installed and logged in (fails fast with a clear message if not).
2. Runs a minimal non-interactive invocation and checks the response matches exactly what was asked.
3. Runs the same prompt in `stream-json` mode and inspects whether more than one incremental chunk arrives before the final result, and — the primary isolation evidence — confirms the CLI's own `init` event reports zero tools and zero MCP servers.
4. A secondary sanity check only: asks Claude directly whether it can see any files or use any tools.
5. Times several representative prompts and reports the samples.
6. Sends a two-turn exchange with the full prior turn re-sent as context in the prompt and checks the second answer correctly references the first.
7. Deliberately triggers a timeout (artificially short) and an invalid-model error to confirm both are caught and reported cleanly.

**Two implementations, same checks:** `scripts/validate-phase0.mjs` (Node) and `scripts/validate-phase0.ps1` (native PowerShell, no Node required — this is the version actually used to validate Phase 0 on this machine). Both write the same `scripts/phase0-result.json` shape.

### A.8 Confirmed Phase 0 result

Run at `2026-07-21T03:23:50-03:00` via `pwsh -File scripts/validate-phase0.ps1`, after the streaming-parser bug in A.3 was found and fixed. Full raw output in `scripts/phase0-result.json`.

| Check | Result | Detail |
|---|---|---|
| **Authentication** | PASS | `claude auth status`: `loggedIn: true`, `authMethod: "claude.ai"`, org `Wellhub` (enterprise), user `giulia.esposito@gympass.com`. |
| **Minimal invocation** | PASS | Non-interactive `-p ... --output-format json` returned `subtype: "success"`, exact expected text `HUBI_PHASE0_OK`, in 9.9s. |
| **Streaming** | PASS — real streaming | 2 distinct incremental `content_block_delta` chunks observed before completion; `realStreamingObserved: true`. |
| **Isolation (primary evidence)** | PASS | CLI's own `init` event: `"tools":[]`, `"mcp_servers":[]`. |
| **No file access (secondary sanity check)** | PASS | Claude self-reported: *"NO — headless engine, no tool access."* Not treated as proof on its own. |
| **Latency** | Small sample only | 2 samples: 8.07s, 8.50s (full completion). Not yet a real p50/p95. |
| **Multi-turn (explicit re-sent context)** | PASS | Turn 2 correctly answered "4271" after the full turn-1 exchange was re-sent as prompt text. |
| **Error handling (invalid model)** | PASS | Non-zero exit, `is_error: true`, no hang. |
| **Timeout handling** | PASS | Artificial 1.5s timeout correctly killed the child process. |
| **Final recommendation** | **`stream`** (true token streaming, not the fallback) | Recorded in `scripts/phase0-result.json` as `reasoningEngineMode: "stream"`. |

**One benign observation, not a defect:** every CLI call emitted `stderr`: *"Warning: no stdin data received in 3s, proceeding without it..."* — expected, since the validation script spawns `claude` with stdin explicitly not connected to a TTY.

**Phase 0 is closed.**

---

# Appendix B: Ingestion Build History

*Preserved verbatim from the original working session.*

### B.0 What's actually in the Content Repository — confirmed by direct inspection

This is a real export of the Drive folder, structured as one subfolder per knowledge asset, named `[RKC-XXXXXX] Title`.

- **20 asset folders** in total.
- **15 contain a DOCX** — these are ingestible as text in v1.
- **5 are video-only, no DOCX** (`RKC-000003`, `RKC-000011`, `RKC-000019`, `RKC-000022` "EU Competition Training", `RKC-000024` "BR Competition Training"). With no OCR or video/audio transcription in scope, these have no extractable text in v1.
- Several DOCX folders also contain supplementary images or videos alongside the document (e.g. `RKC-000004`, `RKC-000006`, `RKC-000018`, `RKC-000026`, `RKC-000027`). These aren't parsed for text.
- There's a top-level `drive-download-...-001.zip` (2.1GB) sitting alongside the extracted folders — a redundant duplicate of everything already extracted. The ingestion scanner filters by supported extension before doing any parsing, so this is skipped automatically and never loaded into memory.

### B.1 A real, consistent document template

All 15 real DOCX files follow the same house template, down to a literal instruction embedded in the file: *"Instruction: Fill this section to help the AI categorize the information correctly."*

- **Heading 1** — document title.
- **Heading 2 — "1. Document Metadata"** — a table with a fixed schema: `Content ID`, `Original Guide Name`, `Description`, `Source URL`, `Learner's URL`, `Taxonomy Level 1`, `Taxonomy Level 2`, `Target Audience`, `Target Region`, `Creation Date`, `Last Updated`.
- **Heading 2 — "Core Knowledge Body"** — the actual substantive content, broken into Heading 3 / Heading 4 subsections.

The ingestion pipeline specifically looks for a "Document Metadata" heading and parses its table by field name (a blank field degrades gracefully instead of breaking), and treats everything under "Core Knowledge Body" as the chunkable content. Any document that doesn't follow this template falls back to generic heading/paragraph/table detection.

### B.2 No Google Drive URL in this metadata schema

The metadata table's `Source URL` field is a WorkRamp admin URL, and there's a separate `Learner's URL` field — also WorkRamp, but the rep-facing version of the same guide. No document inspected contains a Google Drive URL for itself. This was resolved by product decision — see Section 13 and `Architecture.md` Section 6.

### B.3 Real result: 15/15 documents ingested successfully

```
Documents ingested: 15 / 15 DOCX files found
Total chunks: 602
Non-DOCX files skipped (video/image/zip): 24 -- expected, not an error
```

Every single document used the house template. Zero parse failures.

**Confirms video-skip was the right call:** direct evidence from `RKC-000002` (Salesloft - Best Practices for Reps) — its Core Knowledge Body contains an inline, timestamped transcript ("00:00:00 Hello... 00:00:17 Hello...") as ordinary paragraph text. It gets ingested and chunked automatically, with no special video-handling code needed. Nothing is missing from the knowledge base by skipping the `.mp4` files.

### B.4 Two real data-quality observations (not blockers)

- `RKC-000018` ("Launch Readiness no Salesforce PT") has no populated `Learner's URL`, so its citation falls back to the WorkRamp admin `Source URL`, which may not be reachable by a rep in the audience.
- `RKC-000014` ("Launch Readiness in Salesforce ENG") has a value in its `Learner's URL` field that is itself an `/admin/guides/...` style URL rather than the usual rep-facing `/g/...` link — a copy-paste inconsistency in that specific document, not a parsing bug.
- `RKC-000016` has no populated title heading, so its display title falls back to its filename. Cosmetic, not a data-loss issue.

### B.5 Reproduced on the real machine

The 15/15 documents, 602 chunks, zero-failures result above was originally produced in a separate sandboxed dev environment, not the real target machine — that machine had no JS/TS runtime at all until B.6. Re-running the unmodified `lib/ingestion/` code on the real machine, against the real `Content Repository` folder, reproduced the identical result: **15/15 documents, 602 chunks, 0 failures.** The existing TypeScript ingestion code is confirmed working end-to-end in the actual target environment, not just in a sandbox.

### B.6 Runtime: portable Node.js (no admin rights)

The target machine has no admin rights, so a normal Node.js installer was not an option (confirmed: no `node`/`deno`/`bun` anywhere on PATH or in common install locations). Resolution: the official Node.js **portable ZIP distribution** (`node-v24.18.0-win-x64.zip`, downloaded directly from nodejs.org) was extracted to `C:\Users\<user>\.local\nodejs` — no installer, no admin token, no registry changes. It was added to the **user-level** `PATH` (`HKCU\Environment`, not the machine-wide one), so no admin rights were needed there either.

This is the working Node.js baseline for local development on this machine, until IT provides an officially managed installation — switching over is just a PATH change, nothing about the codebase depends on the portable distribution specifically. Per explicit instruction, no application logic was reimplemented in PowerShell to work around this — the existing TypeScript ingestion/retrieval/runtime code is the only implementation, and it runs natively via the portable runtime.

---

# Appendix C: Vertical Slice Validation Log

*Preserved verbatim. This was the milestone that validated retrieval → prompt → reasoning → citation end-to-end, before the Runtime Core milestone added Session State.*

Implemented and tested against the real 602-chunk knowledge base:

- **`lib/retrieval/index.ts`** — zero-dependency in-memory BM25 index over `Chunk[]`.
- **`lib/runtime/promptBuilder.ts`** — the grounded user-turn prompt from retrieved chunks, plus `HUBI_SYSTEM_PROMPT`.
- **`lib/runtime/reasoningEngine.claudeCode.ts`** — the `ReasoningEngine` adapter implemented against Claude Code, using the Phase-0-confirmed isolation flags and `stream-json` output.
- **`lib/runtime/citationBuilder.ts`** — renders a citation for every chunk sent to the model as context.
- **`scripts/ask.ts`** — terminal entry point (single-shot at this point in history; multi-turn came later, in the Runtime Core milestone).

### C.1 What was tested — three real runs against the real corpus

1. **Golden path** — *"What should I do to prepare cadences in Salesloft?"* → 5 relevant chunks retrieved from the Salesloft doc, a grounded, well-structured answer citing team vs. personal cadences and the content report workflow, 5 citations rendered with working WorkRamp links, 10.6s response time.
2. **Safe handling of a gap** — *"What are our main competitors in the EU market and how do we position against them?"* → retrieval surfaced tangentially-related chunks (keyword overlap on "competition"/"position"), but Claude correctly refused to name EU competitors not in the retrieved knowledge, explicitly said so, and offered what was actually available instead of inventing a positioning story.
3. **Zero/weak-match query** — a nonsense query (*"xylophone quantum penguin recipe"*) still matched 2 chunks via BM25 — Claude still correctly declined to answer rather than trusting the retrieval result blindly, confirming the LLM-side grounding instruction is a real second layer of defense, not just a retrieval-quality assumption.

### C.2 Observed limitation — pure lexical retrieval on long, unstructured transcripts

The nonsense-query test surfaced a real, non-hypothetical limitation: `RKC-000008` ("Work the Deal - Part 1") has no internal subheadings, so its entire Core Knowledge Body (a verbatim video transcript) became one 101-chunk block under a single heading. A coincidental single-word overlap between the query and somewhere in that long transcript was enough to produce a nonzero BM25 score, even though the query was nonsense. Not a bug — an inherent property of keyword-only retrieval on long unstructured text. It didn't cause a bad outcome because the prompt's grounding instruction caught it. See Section 5/9 for current status.

### C.3 What was deliberately not built in this milestone

No PDF/PPTX/TXT/MD parsers, no multi-turn conversation memory (added in the next milestone, Appendix D), no web UI, no request classification/context builder/conflict precedence logic.

---

# Appendix D: Runtime Core Milestone Validation Log

*New in this milestone. Full transcripts of the real multi-turn scenarios tested, and the two harness bugs found and fixed along the way.*

### D.1 Bug: readline drops buffered input on EOF mid-turn

Testing multi-turn behavior required piping several lines of input at once (simulating a REPL conversation) via `printf '...\n...\nexit\n' | node scripts/ask.ts`. The first attempt crashed:

```
Error [ERR_USE_AFTER_CLOSE]: readline was closed
    at [kQuestion] (node:internal/readline/interface:441:13)
```

Root cause: the REPL used chained `rl.question()` calls, re-arming a one-shot listener after each turn's async processing completed. When all piped input arrives faster than the ~10–20s it takes to process one turn, the underlying stream reaches EOF (and readline auto-closes) before the next `.question()` call is made — and worse, this doesn't just crash, it **silently drops any already-buffered lines that were never dispatched**. A first fix (guarding with `if (rl.closed) return`) stopped the crash but confirmed the data loss: only turn 1's response appeared, turns 2 and 3 vanished entirely.

### D.2 Bug: concurrent turns interleave streamed output

Switching to the persistent `'line'` event (the standard, more robust readline pattern) fixed the data loss, but surfaced a worse issue: with `rl.pause()`/`rl.resume()` as the serialization mechanism, two turns could still start concurrently when input arrived in a fast burst — Node had already queued multiple `'line'` events before the first handler's `rl.pause()` call took effect. Both turns spawned a `claude` child process at the same time, and their live-streamed text deltas interleaved character-by-character on stdout, producing visibly garbled combined output (fragments of two different answers spliced together mid-sentence).

**Fix:** an explicit queue (`queue: string[]`) plus a `processing` boolean flag in `scripts/ask.ts`, so a new line is always pushed onto the queue and only dequeued/processed once the previous turn's `await handleQuestion(...)` has fully resolved — regardless of how many `'line'` events fire before that. This guarantees true serialization independent of stream-level timing.

### D.3 Scenario: clarifying question + context reuse (real content)

Real business scenario found in `Client Segmentation - Contract Adherence T3/T4` — the correct contract model depends entirely on the client's final tier, which isn't stated up front.

**Turn 1** — *"What contract model should I use for my client?"*
Hubi explained the general Enterprise-vs-SMB rule and asked: *"So, what's your client's final tier as calculated in Salesforce?"* — a genuine clarifying question, not a guess.

**Turn 2** — *"They just finalized as T3."*
Hubi gave a specific, grounded answer: SMB Order Form/Magic Link, flexible rate model, the enterprise-led-deal pricing nuance, and the SMB swap-clause/exception-process note — all correctly conditioned on the tier supplied in turn 2, using the retrieval index re-queried with the accumulated conversation text.

This validates session continuity, context reuse, and clarifying-question behavior together, without any separate classifier component.

### D.4 Scenario: pronoun-style follow-up continuity (Salesloft cadences)

**Turn 1** — *"What should I do to prepare cadences in Salesloft?"* → grounded answer covering the content report workflow and team-vs-personal cadences.

**Turn 2** — *"How do I decide between using a shared one versus building my own?"* (no restatement of "cadence") → Hubi correctly understood "shared one" / "building my own" referred to cadences from turn 1, and gave a grounded, on-topic answer without needing the term repeated.

### D.5 Scenario: safe refusal preserved mid-session, with retrieval noise

Continuing the same session as D.4, **turn 3** — *"What are our main competitors in the EU market and how do we position against them?"*

Retrieval, using the accumulated query (turns 1–3 combined), surfaced a mix of leftover Salesloft chunks and the actual `US & SSL Competition Training` chunk — noisier than a fresh single-turn query would have been (this is the accumulated-query limitation noted in Section 9). Despite that noise, Hubi still correctly refused to name EU competitors not present in the retrieved knowledge, and offered the one tangentially-relevant thing it actually had (competition-law guidance) instead of inventing a positioning story. Confirms the LLM-side grounding instruction holds even when retrieval quality degrades mid-session, not just in a clean single-turn case.

---

# Appendix E: Web UI Milestone Validation Log

*New in this milestone. Every bug found while building and browser-testing the web UI, and the real scenarios run against it.*

### E.1 Bug: `npm install typescript` resolved to a pre-release 7.0.2, breaking the build

`next build` failed with an opaque `The "id" argument must be of type string. Received undefined` error from the TypeScript-checking step. Root cause: an unpinned `npm install` had resolved `typescript` to `7.0.2` — a pre-release build (the native TS-Go port), not a version Next.js's tooling was built against. Pinning to the latest stable `5.x` (`5.9.3`) resolved it immediately. Recorded in `docs/handoff.md` as a specific trap for the next engineer: never let `typescript` resolve to `latest` unpinned in this project.

### E.2 Non-issue confirmed: `.ts` extensions in relative imports

All of `lib/` uses explicit `.ts` extensions in relative imports (required by Node's native ESM loader, which the terminal tool and tests depend on via `node --experimental-strip-types`). There was real concern this would conflict with how Next.js's bundler (Turbopack) resolves imports. Confirmed by testing, not assumed: it compiled cleanly on the first attempt, no config changes needed. One less thing to worry about.

### E.3 Bug: a real type error caught by `next build`'s project-wide type check

`next build` type-checks the whole project via `tsconfig.json`, not just `app/` — it caught `scripts/ask.ts` referencing `rl.closed`, a property that exists on Node's `readline.Interface` at runtime but isn't in `@types/node`'s declarations. Fixed by tracking closed-state explicitly via a local flag set in the `'close'` event handler, rather than depending on the untyped runtime property — arguably a cleaner design regardless of the type error.

### E.4 Security finding: the dev server bound to the network by default, not just localhost

The very first `preview_start` of `next dev` printed `Network: http://192.168.0.12:3000` in its own startup log — Next.js's default binds every network interface, not just `127.0.0.1`. This directly contradicted the approved access model before any testing began. Caught by reading the server's own log output during browser-based verification, not assumed safe from the flag's documentation. Fixed with `--hostname 127.0.0.1` on both `next dev` and `next start`; re-verified by restarting and re-reading the log, which then showed `Network: http://127.0.0.1:3000`.

### E.5 Bug: streamed text visibly duplicated (React Strict Mode + in-place mutation)

First real end-to-end browser test of a chat turn showed the answer duplicated mid-sentence (e.g. "Based**Based** on what teams are doing..."). Root cause: the client's `setMessages` updater mutated the previous message object in place (`last.text += event.text`) instead of returning a new object. React 18+ Strict Mode — on by default under `next dev` — deliberately double-invokes setState updater functions in development specifically to catch this class of impurity; because the mutation touched a shared object reference, both invocations applied, silently doubling every streamed delta. Fixed by making every updater return a new message object for the changed slot, never mutating `prev` — confirmed fixed by re-running the same test and reading the full accessibility-tree text content, not just eyeballing a screenshot.

### E.6 Finding: Claude Code's authenticated identity leaked into a response

A real test response opened with "Great question, Giulia!" — Phase 0's isolation testing confirmed no tools, no MCP servers, and no project-context leakage, but never tested whether the model could infer or state the identity of the authenticated account. It could. Fixed with one added rule in `HUBI_SYSTEM_PROMPT`: "You do not know who is asking. Never address the user by name or assume an identity, even if you think you can infer one." Re-tested afterward across three more scenarios with no recurrence. Flagged in `docs/handoff.md` as a specific thing to watch for if personalized responses ever reappear.

### E.7 Scenario: full golden-path browser test (Salesloft cadences)

Typed the question, watched real incremental streaming render live, confirmed the final answer was coherent (post E.5 fix), confirmed 5 citations rendered as real clickable links (`link` role confirmed via accessibility snapshot, not just visual color), confirmed neutral bubble styling (no clarifying/no-answer badge, correct for a grounded answer), submitted "Not helpful" with a comment, and confirmed both the interaction and the feedback record landed in `logs/interactions.jsonl`, correctly correlated by `interactionId`.

### E.8 Scenario: clarifying-question and grounded-follow-up visual states (contract tier)

Reused the Runtime Core milestone's real T3/T4 contract scenario end-to-end in the browser. Turn 1 rendered with the distinct amber "clarifying-question" styling and the "HUBI NEEDS MORE CONTEXT" badge, no tag visible. Turn 2 ("They just finalized as T3.") rendered as a normal neutral bubble with a specific, correctly-conditioned grounded answer — confirming the tag-based visual state, not just the underlying conversational logic, works through the real UI.

### E.9 Scenario: no-grounded-answer visual state (deterministic path)

A fabricated-non-word query produced the "NO GROUNDED ANSWER FOUND" badge and muted styling instantly (no reasoning engine call, matching the retrieval-level short-circuit design) — confirmed via screenshot and log inspection (`"turnKind":"no-grounded-answer"`, `"latencyMs":0`).

### E.10 Minor unresolved observation: one streamed response had a missing space

One grounded-answer response read "...like the billing setupor the swap clauses..." — a missing space at a word boundary. Traced through the holdback-buffering logic in `lib/runtime/turnKind.ts` and the client's NDJSON parsing loop; neither can drop or reorder characters, only delay when they're flushed, so this is most likely a one-off artifact of how the model itself split that particular sentence across streaming chunks, not a pipeline bug. Not reproduced on a second attempt. Noted, not chased further — worth flagging if a reviewer notices a pattern during rep testing.

---

Once you've reviewed this, let me know what to adjust.
