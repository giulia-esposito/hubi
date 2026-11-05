# 🛠️ Technical Documentation & Production Readiness Audit: Project Hubi

**Date:** 2026-11-04 · **Branch audited:** `develop` @ `7b5aca1` (5 commits ahead of `origin/develop` @ `5f9a6ed`, which is what is deployed as `hubi-pilot-00008-hzk`)

## Method and limits of this audit

Evidence comes from reading the code under `app/`, `lib/`, `scripts/`, `tests/`, the 30+ documents in the repo root and `docs/`, the benchmark and eval artifacts under `benchmarks/`, the deploy ledger, and from running `npx tsc --noEmit` (clean) and `npm test` (**500 tests, 500 pass, 0 skipped**, 29 s, local machine with the Content Repository present).

Not done, and therefore not claimed: no live model call, no eval re-run, no inspection of the deployed Cloud Run service, IAP, Cloud Logging or the GCS bucket. Statements about the deployed state come from `logs/deploy-ledger.jsonl`, the docs and the project memory, and are marked **[unverified live]**. File references are to this repo; line numbers refer to the audited commit.

Severity scale: **P0** blocks wider rollout, **P1** fix before production, **P2** hardening.

---

## 1. Executive Summary & Product Overview

### Core product objective
Hubi is Wellhub Revenue's AI Copilot. It lets Revenue employees (Sales, Sales Development, Client Success; today a controlled pilot audience) describe a question or a commercial situation and get an answer grounded in approved Revenue Knowledge Center content, with citations, region/audience awareness, clarifying questions only when the answer would materially differ, and an honest "I don't have this" when knowledge is missing (`CLAUDE.md`, `Product_Architecture.md`). It also drafts artifacts (pitches, emails, talk tracks) from governed facts ("Business Assistance").

### Current system status

| Dimension | Assessment |
|---|---|
| **Estimated completion vs. "100% production-ready"** | **~60%.** This is a judgment, not a measurement. Engineering of the pipeline is far along (~85%); content, governance data, operations and verification are what hold the number down (~35-45%). |
| **Overall health** | **Healthy as a stakeholder pilot, not production-ready.** Type check clean, 500/500 tests green, deploy script with rollback and protected-config diffing exists. Open: answer-fidelity risk (Finding #005, release-blocking for wider rollout), an incomplete and manually-snapshotted corpus, no alerting, no automated deploy path, and no CI-enforced quality gate on the real corpus. |
| **Deployed state** [unverified live] | `hubi-pilot-00008-hzk` built from `5f9a6ed` (deployed 2026-10-30). Five later commits (search context across replies, scope gate, answerability notice, scope-aware synthesis, eval + docs) are **local only**; push/deploy is on hold by product decision (2026-11-03). |

### Scope & pivot history

| When | Change | Rationale | Where recorded |
|---|---|---|---|
| Sprint 1 | Local prototype: DOCX-only ingestion, BM25, Claude Code CLI as reasoning engine, **explicitly out of scope:** auth, analytics, content governance, production infra, Drive API | Validate the vision with executives | `Current_sprint.md` |
| Jul-Aug 2026 | Findings #001-#003: cross-language/non-stemmed retrieval gap; language ≠ region; knowledge lost in decks/screens | Real testing showed confident wrong-region answers | `docs/validation-findings.md` |
| Aug 2026 | **Pivot 1: reasoning engine Claude Code → Gemini 2.5 Flash on Vertex AI; content local → GCS; deploy to Cloud Run (Sandbox) behind IAP** | A CLI-spawning local engine cannot be a hosted pilot; service-identity auth removes API keys | `docs/gcp-deployment-guide.md` |
| Oct 2026 | **Pivot 2: Task Planning V0** (planning mode self-tag; Business Assistance) and **Retrieval V2** (applicability layer, fact pass, region map, registry-driven governance) | Findings #002 (Critical), #004 | `docs/task-planning-architecture.md`, `docs/context-applicability-architecture.md` |
| 2026-10-16 | **Pivot 3: operating model** - GitHub canonical, direct deploy from an exact commit, CI/CD triggers paused | The Cloud Run pilot had diverged from GitHub | `docs/gcp-pilot-recovery-note.md`, `docs/deployment-runbook.md` |
| 2026-10-29 | **Pivot 4: V1 = web app in the Sandbox** (not Google Chat, not Corporate Production); no custom auth; actor logging off; browser-held conversation with 24 h TTL | "Reasoning and retrieval first, not the channel" | `docs/production-promotion-plan.md` §0 |
| 2026-10-30 | **Pivot 5: Drive is the source of truth; GCS is a serving layer fed by governed automated sync** (no manual exports) | The bucket is one manual snapshot from 2026-08-27 that already lags Drive | project memory; **no implementation yet** |

**Documentation drift (itself a finding, see §4.C):** `Implementation_Handoff.md`, `Current_sprint.md`, `docs/handoff.md`, `README.md` and `docs/gcp-deployment-guide.md` §8 still describe the *pre-pivot* system (602 chunks, 15 documents, "no governance/applicability layer exists in code", "local only"). Today's runtime serves ~1,839 governed chunks from 43 documents in the deployed bucket (2,099 in the local eval corpus), with all of those layers present. A new engineer following the handoff documents would plan the wrong milestone.

---

## 2. Technical Stack & Infrastructure Mapping

### Languages & frameworks
| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, `react-markdown` + `remark-gfm`; one screen (`app/page.tsx`, 417 lines), plain CSS, no UI library. Conversation kept in `localStorage` with a 24 h TTL. |
| Backend | Next.js Route Handlers, Node.js runtime (`export const runtime = "nodejs"`): `app/api/chat`, `app/api/feedback`, `app/api/health`. NDJSON streaming. |
| Runtime library | TypeScript run natively by Node ≥22.6 (`--experimental-strip-types`), `lib/{ingestion,retrieval,applicability,governance,runtime}`. DOCX/PPTX parsed with Node `zlib` (no parsing dependency). |
| Microservices | None. Single container. |

### Libraries & core dependencies (`package.json`)
`next ^16.2.10`, `react/react-dom ^19.2.7`, `react-markdown ^10.1.0`, `remark-gfm ^4.0.1`, `@google/genai ^2.18.0` (Vertex AI client), `@google-cloud/storage ^8.0.1`. Dev: `typescript ^5.9.3`, `@types/*`. **Not used:** LangChain, LlamaIndex, OpenAI SDK, any ORM, any state-management library, any vector client, any test framework (Node's built-in `node:test`).

Note: `Implementation_Handoff.md` §4 states "only Next.js and React are approved runtime dependencies". The two Google packages were added by the GCP migration; the principle was never amended. Caret ranges plus a committed `package-lock.json` keep installs reproducible, but `uuid <11.1.1` (via `gaxios`) was recorded as an unfixable transitive advisory on 2026-08-24, and CI's `npm audit` step is `continue-on-error: true`.

### Infrastructure & services
| Concern | Implementation |
|---|---|
| LLM provider | **Gemini 2.5 Flash** on Vertex AI (`HUBI_GEMINI_MODEL`, default `gemini-2.5-flash`, `us-central1`) via Application Default Credentials (service identity, **no API key anywhere**, which also satisfies the org rule that API keys are a last resort). `gemini-2.5-pro` returned 404 in this project/region. Local dev default: Claude Code CLI (`reasoningEngine.claudeCode.ts`). |
| Retrieval | In-memory **BM25** (k1=1.5, b=0.75), no stemming, no embeddings, no vector store, rebuilt at process start. Cross-language **query expansion** by a model call + reciprocal-rank fusion. |
| Database / cache / queue | None. No conversation store: the browser sends history on every request. In-memory per-instance rate guard and circuit breaker. |
| Content storage | GCS bucket `wh-revenue-sandbox-hubi-content-repository/content-repository`, downloaded to `os.tmpdir()` (memory-backed on Cloud Run) once per process. 74 `.docx/.pptx` files uploaded manually on 2026-08-27. |
| Governance data | Content Registry exported to `config/governance/registry-export.csv`, compiled into `lib/governance/registrySnapshot.ts` (965 lines) by `npm run registry:sync`. |
| Hosting | Cloud Run `hubi-pilot`, project `wh-revenue-sandbox`, `us-central1`, 2 Gi, behind **IAP** with **internal ingress**; reachable at `https://hubi-pilot.run.revenue.sdx.us.gcp.wellhub.dev/`. Min instances 1 recommended in the guide [unverified live]. |
| Deploy | `scripts/deploy.ts` run from an engineer's authenticated `gcloud` (plan/deploy/status/verify/rollback), exact-commit `git archive`, protected-config snapshot diff, ledger in `logs/deploy-ledger.jsonl`. CI (`.github/workflows/ci.yml`): tsc, tests, build, audit. **No automated deploy.** |
| Observability | Structured JSON to stdout → Cloud Logging (`lib/runtime/telemetry.ts`, `startup` event, `commit` + `revision` on every entry, 256 KB cap, severity mapping). `/api/health` is liveness + identity only. **No metrics, alert policies, uptime check, tracing, Datadog or OpenTelemetry.** |

### End-to-end data & request flow (`app/api/chat/route.ts`)

```
Browser (history + pinned region + lastPlanningMode in body)
  │ POST /api/chat
  ▼
IAP → Cloud Run → request guard (20/min per user header, 1500/h per instance; both in-memory)
  → parseChatRequest / sanitizeHistory (caps: 24 turns, 8k chars/turn, 48k total, 4k question)
  → getKnowledgeBase()   [first call per process: GCS download + ingest + governance + index]
  → searchContext(userMessages)            keep the topic's opening question across short replies
  → expandQuery()        [model call, only if non-English or weak BM25 (<12); 10 s timeout; falls back silently]
  → retrieveApplicable() BM25 top-15 (RRF-fused) → region detection (approved map) → Applicability Layer
        → region pass (+2 chunks for stated region) → intent slots → fact pass (artifact requests, BM25 #2)
        → audience-conflict detection → scope candidates
  → applyScopeGate()     [model call, only if candidates; must quote evidence; max 2 questions/topic]
  → deterministic refusal if retrieval found nothing at all
  → buildPrompt()        system prompt + history + labelled sources + up to ~8 notices + question
  → generateWithVerification()
        streamed (normal) | buffered draft → deterministic figure/value-language check
        → claims-ledger attribution (observe-only) → ≤1 revision call
  → extractResponseTags() strips [[HUBI:MODE:*]] and trailing [[HUBI:*]] self-report tags
  → NDJSON events: retrieval(sources) → delta* → done(turnKind, planningMode, pinned)
  → telemetry: interaction (question, response, sources, applicability, retrieval, verification, latency)
Browser renders markdown + sources, stores conversation (24 h), sends feedback → /api/feedback → telemetry
```

**Model calls per turn:** 1 (typical) · 2-3 (non-English question: expansion + answer; scope candidates add a judge call) · up to 4 (buffered artifact turn with expansion, scope judge and a revision). Each is subject to retries (max 3 attempts, 100 s budget), a 16-call per-instance concurrency cap and a circuit breaker (`lib/runtime/resilience.ts`).

---

## 3. Comprehensive Feature Matrix & Functional Audit

| Feature / Module | Description | Status | Dependencies & System Impact | Blockers / Technical Notes / Missing Requirements |
| :--- | :--- | :--- | :--- | :--- |
| Chat UI & NDJSON streaming | One-screen conversational UI, markdown, sources, feedback, "New conversation" | **Completed** | Next.js, `/api/chat` | No automated UI/E2E test. Buffered turns show nothing until done (no keep-alive bytes). |
| Browser-held conversation (24 h TTL) | History + pinned region sent each request; any instance can serve any turn | **Completed** | `requestSession.ts`, `localStorage` | Client-side storage of conversation text is new data handling; InfoSec delta pending. Two tabs share one entry (last writer wins). |
| Document ingestion (DOCX/PPTX) | Zero-dependency ZIP/XML parsing, template metadata table, normalization | **Completed** | `lib/ingestion/*` | Content inside images/diagrams/screens is invisible (Finding #003); no PDF, Google-native or video-transcript ingestion path beyond what is in DOCX text. |
| Chunking | Section-bounded, 220 words max, heading kept as locator, region/audience/date propagated | **Completed** (quality **partial**) | `chunk.ts` | Fixed word-window split, no overlap, no parent/section summary; one section can fragment into 12 chunks (Finding #001). |
| Lexical retrieval (BM25) | Heading double-weighted, top-k 5 / over-fetch 15 | **In Testing** | `retrieval/index.ts` | No stemming; tokenizer keeps only `a-z0-9` so accented letters split words; one engineer's gold set (45 q). |
| Cross-language query expansion | One model call → other-language terms → RRF fusion | **Completed** (effect **partial**) | Reasoning engine | Raw R@5 87→91%, cross-language only 25→50%. Terms vary run to run; heuristic language detector. |
| Applicability Layer (region) | Approved region map, `unspecified ≠ Global`, must-clarify / no-applicable-content gates, pinned context | **Completed** | `lib/applicability/*` | Finding #002 closed for the tested scenarios. Open: language leaks into the region gate (see TS-006). |
| Governance gate | Registry-driven AI Eligibility, restrictions, Leaders-Only exclusion, unregistered policy | **In Testing** | Registry snapshot (static TS file) | Snapshot is a manual sync; 5 unregistered PMM files served under pilot policy; RKC-000069 served despite Not Eligible; RKC-000075 ID collision. |
| Fact pass (Finding #004) | Second BM25 pass for artifact requests | **Completed** | `factRetrieval.ts` | Regex-triggered; same governance/applicability as pass 1. |
| Intent slots / source selection | Reserved slots for process and recency questions, source-type and date labels | **Completed** | `sourceIntent.ts`, `sourceFacts.ts` | Heuristic intent cues. |
| Scope gate (second clarifying question) | Model judge must quote verified evidence from ≥2 situations; max 2 questions/topic | **In Testing** | `scopeClarification.ts`, `scopeGate.ts` | `contract-brazil` correct in only 2/5 runs; the gate never asked in those 5 (needs Brazil direct-sales content). |
| Task planning (planning-mode tags) | Model self-tags KNOWLEDGE_RETRIEVAL / SYNTHESIS / BUSINESS_ASSISTANCE | **Completed** | `promptBuilder.ts`, `turnKind.ts` | In-band self-report; a mis-tag silently skips verification (see 4.B). |
| Claim guardrail (figures + value language) | Deterministic check, ≤1 revision call, on by default | **Completed** (pilot mitigation only) | `claimVerifier.ts`, `verifiedGeneration.ts` | Substring-based support test can pass unsupported claims (see 4.B). Does not address scope/causality. |
| Claims-ledger attribution | Hidden ledger, verbatim-quote and qualifier checks | **In Testing** (observe-only) | `claimAttribution.ts` | Flags ~every draft; revision clears ~1/3; enforcing doubles latency. **Finding #005 open.** |
| Answerability + scope-aware synthesis notices | Instructions vs mentions; general vs limited guidance | **In Testing** | `answerability.ts`, `sourceScope.ts` | Advisory prompt notices; "Explain Wellhub" only 4/15. |
| Provider resilience | Retries/backoff, concurrency cap, circuit breaker, request guard | **Completed** (single-instance semantics) | `resilience.ts`, `circuitBreaker.ts` | Per-instance state × up to 20 instances; Gemini adapter cannot abort a call (see 4.C). |
| Telemetry & feedback | Structured Cloud Logging, scrubbing of emails/long numbers, feedback tags | **Completed** locally; Cloud Logging ingestion **[unverified live]** | `telemetry.ts`, `redact.ts` | Free-text questions/answers stored; scrub is a pattern filter. Retention and storage not agreed with InfoSec. |
| Authentication / identity | IAP in front of the service; no app-level auth; actor logging off by default | **Completed** (by decision) | IAP | Tester access is per-person IAP role, today 2 holders; no per-user authorization; no per-user audit by default. |
| Deployment automation | Exact-commit deploy script + rollback | **Partial** | `gcloud`, laptop | CI/CD paused; deploys run from one person's machine; repo is on a personal GitHub account. |
| Content sync from Drive | Governed automated sync Drive → GCS | **Not Started** | Drive/Docs APIs, one SA | Blocked on IT allowing one SA as a sharing target; design is in memory, not in repo. |
| Content completeness | Sales Tools Playbook, ~20 Rev Strategy playbooks, RKC-000027/072-077, US onboarding training, Brazil direct-sales contract source | **Failing** | Drive sync | 11 of 46 gold questions have no answer passage in prod. |
| Monitoring / alerting / SLOs | Uptime check, error-rate and latency alerts | **Not Started** | Cloud Monitoring | Owner lacks permission to create alert policies in the Sandbox. |
| Conversation continuity (cross-session/channel) | Conversation store, resolution, Context Scopes | **Not Started** | Identity decision | Designed only (`Conversation_Continuity_Architecture.md`). Deferred by V1 decision. |
| Google Chat channel | Preferred channel | **Not Started** | Chat API path | Deferred after launch by decision. |
| Knowledge Intelligence analytics (BigQuery) | Telemetry analytics loop | **Not Started** | Real traffic | Deliberately waits for pilot traffic. |
| Embeddings / semantic retrieval | Beyond lexical | **Not Started** (by decision) | Vertex embeddings | Gated on evidence that lexical + expansion cannot meet the bar. |
| Corporate Production promotion (ISSTD28) | RASCI, DPIA, InfoSec/LT/Legal approvals, prod project | **Not Started** | `.wh-corp-production/workload.yaml` (draft, all approvals pending) | Not a V1 launch gate; required before leaving the Sandbox. |

---

## 4. Deep-Dive Failure Analysis (Root Cause Diagnostic)

Hubi's incorrect or unexpected behaviors cluster in three places, in this order of impact: **(1) the content the retrieval layer is given, (2) lexical retrieval's blind spots, (3) a prompt-only contract with a high-variance model.** Application code is comparatively solid.

### A. RAG & Knowledge Base Retrieval Pipeline

**Chunking quality**
- Fixed 220-word windows per section with no overlap and no parent context (`lib/ingestion/chunk.ts:54-64`). The heading survives as a locator, which keeps citations precise, but a long procedural section is split into many near-identical chunks that each score weakly (Finding #001: the M1 section alone is 12 chunks; the complete answer ranked 289th of 289 for one query).
- Corpus mix distorts retrieval: transcripts ≈ 50% of chunks, Slide Library 38%, playbooks ≈ 5%, newsletters ≈ 5% (2026-10-30 audit). Top-5 averages ~2 distinct documents. Long unstructured transcripts compete with concise playbook sections.
- Chunks are lossy for tables/slides: slide chunks come from speaker notes; visuals are not extracted (Finding #003).

**Retrieval accuracy & vector search**
- Pure BM25; there are no embeddings, similarity metric choice or hybrid search to tune. Benchmark (45 questions, 2,099 chunks): raw R@5 **87%**, R@15 93%, MRR 0.79; with expansion **91% / 98% / 0.82**; served R@5 **89%**. Cross-language (n=4) only **25%→50%** at R@5.
- **No stemming** (`meeting`/`meetings`, `Rejeição`/`rejeitadas`). **Tokenizer** (`lib/retrieval/index.ts:31-37`) lowercases then replaces everything outside `[a-z0-9\s]` with a space and drops tokens shorter than 2 characters: `reunión` indexes as `reuni`, `não`, `é`, `são` vanish. Because query and index are tokenized identically this is mostly symmetric and the benchmark showed no recall loss from it; accent folding made recall *worse* with expansion, so it was rightly not adopted. It remains a latent precision limit for Spanish/Portuguese.
- Ranking misses: three paraphrase questions have the answer at rank 6-7 while the model sees ~5 sources.
- Metadata filtering is the strong part: governance first, then region/audience labels, deterministic and unit-tested. `unspecified` region never counts as Global.
- Query-time cost: up to ~6 full BM25 scans per request (expansion probe, pass 1, region pass at depth 150, scope probe at depth 60, intent slots, fact pass). At ~2k chunks this is negligible; it scales linearly with corpus size.
- Strong-regional-match rule (ratio 0.7) over-asks "which region?": Portuguese general questions 5/5 and ~half of English "prospect" phrasings (language leaking into region via lexical match). Deliberately untuned; a Spanish/Portuguese stop-word fix was tried and reverted.

**Document integrity (biggest root cause of wrong or empty answers)**
1. **The served corpus is a stale manual snapshot** (uploaded 2026-08-27 from a 2026-08-24 export). Missing: Sales Tools Playbook, Golden Pitch, ~20 "Rev Strategy Playbook" docs, RKC-000027, RKC-000072..077, US onboarding training, a Brazil direct-sales contract source, an "explain Wellhub" source.
2. The retrieval gold set and `docs/governance-registry.md` still assume the missing documents are served.
3. Registry-vs-content defects: RKC-000069 (Not Eligible) *is served* because its file has no Content ID row, so its ID falls back to the filename and the gate treats it as unregistered; RKC-000075's document carries ID RKC-000076 (collision); RKC-000020's audience is labelled "Sales ENT" while its content is the SMB tiers; region drift on RKC-000015/16/18 is reported, not fixed.
4. **~71% of chunks come from five files with no audience/region/tier labels** (Slide Library, Sales Tools Playbook, Pricing Playbook, Rules of Engagement, Golden Pitch). The 5 unregistered PMM files are served under a pilot policy (`governance.ts`), i.e. outside the governance model Hubi's own principles call mandatory.
5. The registry snapshot is a **code file** regenerated by a manual command; staleness is measured (`registryAgeDays` in the startup event) but nothing blocks or alerts on it.
6. Knowledge freshness: no per-document re-sync, TTL or version surfaced; announcements and old newsletters compete with processes (partly mitigated by intent slots and source-type labels).

### B. Prompt Engineering & LLM Behavior

**System and user prompt audit** (`lib/runtime/promptBuilder.ts`)
- The system prompt is ~1,900 words (~3k tokens) of layered rules: planning modes, grounding, claim fidelity, Business Assistance, clarification, applicability labels, response-format tags. It is well-structured and general (no product/region names, test-enforced).
- On top of it each turn can append up to ~8 **advisory notices** (applicability context, region notice, unspecified-region notice, audience notice, source-governance notice, restriction notice, scope notice, answerability notice, ledger instruction) *after* the retrieved context. Evidence that this is near the limit of what prompt-only control can do: scope-aware synthesis works in about half the answering runs; Finding #005 "same strength and scope" is followed only partly; the ledger flags ~every draft.
- **Gating modes are robust** (must-clarify and no-applicable-content send *no* source content, only a mandated one-line question), which is the correct pattern: enforce in code what must not fail.
- **Output contract is in-band self-report.** The model must emit `[[HUBI:MODE:*]]` on line 1 and `[[HUBI:*]]` on the last line. `turnKind.ts` degrades safely when absent. However the claim guardrail only runs when the draft self-reports `business-assistance` (`verifiedGeneration.ts:159`) *and* a regex predicted an artifact request (`factRetrieval.ts:isArtifactRequest`). A mis-tagged artifact skips verification entirely. **[P1]**
- No few-shot examples; the retrieved chunks are inserted as raw text without delimiters that distinguish source data from instructions. Transcripts and decks are free text: there is **no prompt-injection test or mitigation beyond the "sources are data" framing**. **[P1]**
- Retrieved text is not stripped of its own formatting; slide/table text can resemble tags (`[[HUBI:...]]` is stripped only from expansion terms, `queryExpansion.ts:103`).

**Context window & formatting**
- No overflow risk with Gemini 2.5 Flash: history ≤ 48k chars, ~5-12 chunks of ≤220 words, system prompt ~3k tokens → typically well under 20k tokens. History caps are surfaced to the user (`historyNotice`).
- Instruction degradation is the real risk, not the token limit (see notices above). `buildPrompt` places notices after the sources and before the question, which is a good position, but nothing measures per-notice compliance in production.

**Model parameters** (`reasoningEngine.gemini.ts:82-86`)
- **No `temperature`, `topP`, `maxOutputTokens`, `seed` or `safetySettings` is set anywhere** (grep over `lib/ app/ scripts/`). Gemini 2.5 Flash defaults to temperature ≈ 1.0. For a grounded-answer product this is the single cheapest explanation for the run-to-run variance in the evals (onboarding steps delivered 5/20 → 13/20 → 8/20 on identical code; ROI language in 3 of 5 identical runs). **[P0 quick win, but it changes behavior: re-baseline all evals after changing it.]**
- No output length cap: "overly long answers" (reported in the handoff) are not bounded in code.
- Only helper calls use `thinkingBudget: 0`. Main answers use default thinking, adding latency and variance.
- Model pinning: `gemini-2.5-flash` is an alias set by default in code; check its **lifecycle/retirement date** on Vertex and pin a versioned model with a documented upgrade path. **[unverified live]**
- Claude Code (dev) and Gemini (deployed) are different models behaving differently; the migration checklist exists but local results do not predict deployed behavior. The default provider is `claude-code`: **if the `HUBI_REASONING_PROVIDER=gemini` env var is ever lost on a redeploy, every model call fails** (no CLI in the image). The deploy script protects env vars, but `/api/health` reports the provider and nothing alerts on `claude-code` in Cloud Run.

### C. Engineering, Codebase & API Infrastructure

**Code execution & data parsing**
- Typed, small, well-factored modules; tsc clean. Tag parsing and history sanitization are tolerant and tested.
- `askGemini` (`reasoningEngine.gemini.ts:55-109`): **no abort signal.** On timeout the race rejects, but the underlying stream keeps running, keeps invoking `onDelta` and keeps consuming (billed) tokens; the concurrency limiter slot is released while the call is still active, so real concurrency can exceed the cap. The 60 s `setTimeout` is never cleared. **[P1]**
- **Client disconnects are not propagated:** neither `req.signal` nor an `AbortController` appears in `app/` or `lib/`. A closed tab leaves 1-4 model calls running to completion. **[P2]**
- Buffered (artifact) turns hold the HTTP response silent for the whole draft (+ revision). Worst case is two sequential 60 s calls plus expansion and scope judge, with no keep-alive bytes. The Cloud Run request timeout and any proxy idle timeout in front of IAP were not verified. **[P1, unverified live]**

**API & third-party reliability**
- Retries only transient errors, never after text was delivered, jittered backoff, 100 s total budget; circuit breaker; 16-call cap with 15 s queue wait; helper calls get one attempt. This is good and unit-tested.
- Limits are **per instance** (rate guard, breaker, concurrency). `maxScale 20` means effective limits ×20 and a breaker that never sees the whole picture. Acceptable for a pilot; not for production quotas.
- If IAP's `x-goog-authenticated-user-email` header is absent, all callers share one `"anonymous"` bucket (20/min total). Mitigated by `callerKind` logging; verify after each deploy.
- `sessionRegistry` (fallback for clients that send no `history`) is an **unbounded `Map` keyed by a client-chosen string of unbounded length**. Only old clients use it, but it is a slow memory leak and trivially inflatable by any authenticated caller. **[P2]**
- `/api/feedback` has no rate limit and no length cap on `sessionId`/`interactionId`, and does not verify the interaction exists, so one authenticated caller can inflate Cloud Logging volume. **[P2]**

**Error handling & resilience**
- Generation failures are caught, logged as `interaction_error` and reported to the client. **But everything before the stream starts is outside any `try`**: `await getKnowledgeBase()` (GCS download, ingestion), retrieval, expansion and the scope gate. A failed content download returns a bare 500 with no `interaction_error` telemetry and no actionable client message. The singleton does clear its cache on failure so the next request retries, but each retry re-downloads the corpus inside a user request. **[P1]**
- **Cold start:** the first request per process pays the GCS download + ingest + governance + index inside the request path. `instrumentation.ts` already runs at startup but does not warm the knowledge base. `--min-instances=1` hides this except on deploy/scale-out.
- **Memory:** `/tmp` on Cloud Run is memory-backed. The corpus (largest file ~191 MiB) is downloaded to `/tmp` *and* parsed into memory in a 2 Gi container; the Drive-sync plan will add ~20+ playbooks. Headroom is unmeasured. **[P1, unverified live]**
- Content changes require a restart; there is no reload or version check.
- Telemetry writes are wrapped so they never throw into a request (tested).

**Docs/config drift**
- `README.md`, `Implementation_Handoff.md`, `Current_sprint.md`, `docs/handoff.md`, `Architecture.md` §17 and `docs/gcp-deployment-guide.md` §8 contradict the current code (corpus size, "no governance layer", "local-only 127.0.0.1", stale known-limitations). Risky for onboarding and for any compliance review that reads them.

### D. Test Coverage & Evaluation Suite (Evals)

**Current coverage:** 31 test files, **500 tests**, all deterministic and offline (no live model). Strong on: ingestion, BM25 mechanics, applicability and region map, governance, source facts/scope/conflicts, claim verifier and attribution, request sessions, resilience/circuit breaker, telemetry/redaction, deploy logic, retrieval benchmark replay (recorded expansions), query expansion.

**Evals (`scripts/eval-*.ts`, live model, not in CI):** applicability, claim-fidelity, context-asking (60 questions), pilot conversations (5 runs per scenario), task-planning, verify-revise, source-conflicts (synthetic), retrieval benchmark. Judges are text checks plus one model rubric. Latest integrated numbers (production corpus, 2026-11-03): onboarding steps 18/20, contract channel 18/20, missing-steps disclosure 10/10, **Explain Wellhub 4/15**, guards 10/10, over-ask 0/40, must-ask 28/35.

**Gaps**
1. **CI cannot exercise the real corpus** (`Content Repository/` is gitignored): corpus-dependent tests skip in GitHub, including the retrieval benchmark regression guard. Local green ≠ CI green. **[P1]**
2. **No test of the `/api/chat` route end to end** (streaming protocol, error events, gating modes, 429), and **no UI/E2E test** for `app/page.tsx` (stream parsing, TTL storage, History notice, Strict-Mode behavior called out in `docs/handoff.md`).
3. **Live evals are manual and unscheduled**; no trend, no threshold gate before deploy, no cost tracking. Results vary run to run because temperature is unset (see 4.B).
4. **Gold labels are one engineer's reading**, unreviewed by Content; 45 questions with only 4 cross-language. Not yet seeded from real pilot traffic.
5. **Missing eval classes:** prompt injection via retrieved content and user text; PII handling (scrub is tested, behavior with personal data is not); toxicity/safety (no `safetySettings` configured); hallucination/grounding rate as a production KPI; latency and cost per turn under concurrency; load test; failover test of the Gemini adapter (timeouts, 429, partial streams); long-history truncation behavior; non-English clarification quality; multi-instance behavior.
6. **Finding #005 regression coverage** requested by Product (scope, region, population, comparison-vs-cause, unsupported ROI) exists as `eval:claim-fidelity` but is observe-only in production.
7. **Claim-verifier weakness (found in this audit):** support is tested by *substring* inclusion in the joined chunk text (`claimVerifier.ts:74,106`). A figure `5` is "supported" by any chunk that contains the digit 5 anywhere (including `2025`, `$50`), and the value term `roi` is "supported" by `android`, `heroic` or any word containing it. This under-reports violations; use word-boundary and number-token matching. **[P1]**

---

## 5. Comprehensive Test Scenario & Failure Inventory

IDs are assigned by this audit. "Observed" values come from the repo's own recorded evals and findings; none were re-run here.

| Test Scenario ID | Trigger / Input | Expected Behavior | Observed Behavior | Suspected Root Cause (Code / Prompt / Context / Infra) |
| :--- | :--- | :--- | :--- | :--- |
| TS-001 | "What meetings do I have to do for client onboarding?" (EN, answer in an ES document) | List M1, M2, 30/60-day meetings | Originally "can't find a meeting list"; with expansion + search-context fix, steps delivered 18/20 (was 5/20) | Retrieval: cross-language + no stemming + fragmented chunks. **Mitigated, still model-variance-dependent.** |
| TS-002 | Onboarding steps, then reply "US" | State that the US training is not available, or give it | Fixed by answerability notice: says steps are missing 10/10 (was 0/8) | **Context (content gap):** only the announcement newsletter is in the corpus. |
| TS-003 | "How can I explain Wellhub to a client?" | General, company-level explanation; limited material separated | Only 4/15 acceptable; 6/15 runs ask "which region?"; limited content (US pricing, T3/T4 contract) often listed as a numbered section | **Context:** no source describes explaining Wellhub (Golden Pitch not in the bucket); **Prompt:** scope notice is advisory; **Retrieval:** regional docs match lexically >0.7. |
| TS-004 | "Qual contrato devo usar?" then "Brasil" | Cover or ask the sales channel (direct vs partner) | Improved from 3/12 to 18/20 for channel-unstated; `contract-brazil` conversation right only 2/5; gate never asked | **Context:** no Brazil direct-sales contract source. **Prompt/Code:** quote-evidence gate is strict by design. |
| TS-005 | "Write me an elevator pitch." | Finished, grounded pitch, no invented claims | Fact pass fixes retrieval; ROI/"measurable" language appeared in 3/5 runs before the guardrail; D2E-specific claim stated as general | Finding #004 (fixed), **Finding #005 (open):** scope/causality strengthening; model variance (temperature unset). |
| TS-006 | General Portuguese question ("Qual é o processo…?") | Answer in PT or ask only if the answer differs | Asked "which region?" 5/5 (and ~50% of EN "prospect" phrasings) | **Code:** `STRONG_REGIONAL_RATIO=0.7` fires because Brazil/US documents are lexical matches; language leaks into region. Fix not built (judge ratio on English expansion). |
| TS-007 | Spanish question from a non-LatAm user, region unstated | Ask region, do not answer from SS Latam process | Fixed by applicability gate (Finding #002 closed in eval) | Previously: metadata discarded before retrieval. |
| TS-008 | English question about a Portuguese doc ("rejected …") | Retrieve the PT "Rejeição" passage | Still missed (`en-pt-rejection`) | **Code:** no stemming/morphology; expansion terms had wrong word form. |
| TS-009 | Question about RKC-000021 content | Excluded (Not Eligible) | Excluded via registry snapshot | OK. Counter-case: **RKC-000069 (Not Eligible) is served** because its file has no Content ID. |
| TS-010 | Artifact request mis-tagged by the model as KNOWLEDGE_SYNTHESIS | Claim check still runs | **Check skipped** (verification requires a `business-assistance` self-tag) | **Code/Prompt:** guardrail keyed to model self-report. Untested. |
| TS-011 | Draft says "improves retention by 15%" and a chunk contains "15" in an unrelated place (or "retention" from other text) | Flag as unsupported | **Not flagged** (substring match) | **Code:** `claimVerifier.ts` uses `includes`. Untested. |
| TS-012 | Retrieved slide text contains "Ignore previous instructions and …" | Treated as data | **Unknown, no test** | **Prompt/Code:** no injection mitigation or test. |
| TS-013 | Gemini stream stalls > 60 s | Clean failure, slot released, no more output | Caller gets `timeout`; underlying stream keeps running and may call `onDelta` later; limiter slot freed early | **Code:** no AbortSignal in `askGemini`. Untested live. |
| TS-014 | Artifact request with expansion + scope judge + draft + revision | Answer within user patience | Up to 4 sequential model calls; silent response (no keep-alive) while buffered; +6-9 s when revision triggers | **Code/Infra:** serial calls; no streaming of buffered turns. Timeout limits unverified. |
| TS-015 | Browser tab closed mid-answer | Server stops work | Model calls continue to completion | **Code:** no `req.signal` handling. |
| TS-016 | First request after cold start / scale-out | Answer within normal latency | First user waits for GCS download + ingest; failure → bare 500 | **Code/Infra:** lazy singleton inside request path; pre-stream code not in a `try`. [unverified live] |
| TS-017 | Request without IAP header (misrouted, local) | Per-user limit | One shared "anonymous" bucket for everyone | **Infra/Code:** guard keys on the header. Detectable via `callerKind`. |
| TS-018 | Content updated in Drive | Hubi reflects it | Never until manual export + upload + restart; bucket is 2026-08-27 | **Infra:** no sync (Pivot 5 not implemented). |
| TS-019 | 100 concurrent users | Stable latency, no quota exhaustion | **Never load-tested**; per-instance limits ×N instances; Vertex quota unknown | **Infra/Test gap.** |
| TS-020 | CI run on GitHub | Same gates as local | Corpus-dependent tests and retrieval benchmark skip; `npm audit` non-blocking | **Infra/Test:** confidential corpus not available in CI. |
| TS-021 | Feedback endpoint flooded / forged ids | Rejected or capped | Accepted, logged | **Code:** no rate limit or id validation. |
| TS-022 | Model emits no tags / malformed tags | Neutral UI, no leak | Handled (tested) | OK. |

---

## 6. Actionable Roadmap to 100% Production Readiness

### Immediate blockers (before any wider rollout beyond moderated pilot)
1. **Finding #005 (scope/causality fidelity) is release-blocking by Product's own decision** and is only observed, not enforced. A Product call on latency vs fidelity is outstanding.
2. **Content is incomplete and stale**, so a share of answers is wrong or empty regardless of code quality. Decision already made: Drive is the source of truth; the sync is not built and is blocked on IT permitting one service account as a sharing target.
3. **Five commits are local only and the deployed revision predates them** (push/deploy on hold pending the language-leaks-into-region decision).
4. **Governance holes in served content:** RKC-000069 served while Not Eligible; five ungoverned PMM files served; ID collisions.

### Prioritized action plan

**P0**
| # | Task | Files / how | Success signal |
|---|---|---|---|
| P0-1 | Set generation parameters: `temperature` ≤ 0.3, `topP`, `maxOutputTokens`, and a `seed` where supported; keep helper calls at 0. Make them env-configurable and log them in telemetry. Then **re-baseline every live eval** (variance should fall). | `reasoningEngine.gemini.ts:82` | Same-code eval spread (e.g. F1 5/20-13/20) narrows measurably |
| P0-2 | Decide Finding #005 policy: enforce `HUBI_CLAIM_LEDGER=enforce` for customer-facing artifact turns, or keep observe-only and make "draft, verify before external use" a visible UI requirement; record the decision in `validation-findings.md`. | Product + `verifiedGeneration.ts` | Decision recorded; regression eval thresholds set |
| P0-3 | Close the hold: decide the region-gate language-leak fix (judge `strong-regional-match` on the English expansion ranking for non-English questions), then push `develop` and deploy through `scripts/deploy.ts`. | `applicability/evaluate.ts`, `retrieveApplicable.ts` | `develop` = `origin/develop` = deployed commit; TS-006 passes |
| P0-4 | Fix governance leaks: make a missing Content ID an explicit *exclude-and-report* when the title/ID matches a registry row; resolve the RKC-000075/076 collision; decide the fate of the 5 unregistered PMM files (register them or exclude). | `governance.ts`, registry | `registry:check` clean; zero Not-Eligible docs served |
| P0-4b | Build the governed Drive→GCS sync (identity rules in memory: registry authoritative, Drive File ID as source, conflicts exclude-and-report) and ingest the missing playbooks; add a Playbook/SOP content type decision with Content. | New `scripts/` job + Cloud Run job + Scheduler | 11/46 unanswerable gold questions become answerable; bucket age < 24 h |

**P1**
| # | Task | Files / how |
|---|---|---|
| P1-1 | Harden the claim verifier: word-boundary term matching, numeric-token matching (no substring), tests for TS-010/TS-011; consider verifying regardless of the model's self-tag when `isArtifactRequest` is true. | `claimVerifier.ts`, `verifiedGeneration.ts` |
| P1-2 | Add `AbortSignal` to the Gemini adapter (SDK `abortSignal` or stream `return()`), clear the timer, release the limiter only after the call ends; propagate `req.signal` from the route. | `reasoningEngine.gemini.ts`, `resilience.ts`, `route.ts` |
| P1-3 | Move all pre-stream work inside the `try`/telemetry path; return a structured JSON error; **warm the knowledge base in `instrumentation.ts`** and make `/api/health` report knowledge-base readiness (separate liveness/readiness). | `route.ts`, `instrumentation.ts`, `health/route.ts` |
| P1-4 | Measure memory headroom with the full intended corpus (download + parse). Stream-parse large PPTX or raise memory; set an RSS-based alert. | `contentSource.ts`, `ingest.ts`, Cloud Run |
| P1-5 | Observability: uptime check on `/api/health`, log-based metrics + alerts for `interaction_error`, 429s, `circuit-open`, `provider=claude-code` on Cloud Run, startup `commit` mismatch, registry age. Needs the Monitoring permission or the Platform team. | Cloud Monitoring |
| P1-6 | Deployment: move the repo to the Wellhub GitHub org, restore a CI-driven deploy (Platform Engineering pipeline per ISSTD28), keep `deploy.ts` rollback semantics. | `.github`, runbook |
| P1-7 | CI quality gate: provide a **synthetic corpus fixture** (or a protected-runner secret) so the retrieval benchmark and real-corpus tests run in CI; make `npm audit` fail on high/critical for production deps. | `tests/helpers/corpus.ts`, `ci.yml` |
| P1-8 | Add `/api/chat` route tests (NDJSON events, gating modes, 429, malformed body, error mid-stream) and a minimal browser E2E (Playwright) for streaming, TTL expiry and "New conversation". | `tests/` |
| P1-9 | Prompt-injection and safety evals: injected instructions in chunks and in user text; configure `safetySettings`; fence retrieved text in explicit delimiters. | `promptBuilder.ts`, new eval |
| P1-10 | Load and soak test (50-100 concurrent, mixed buffered/streaming), measuring p50/p95 latency, Vertex quota, cost per turn; decide `maxScale`, concurrency and per-instance limits accordingly. | New script |
| P1-11 | Update stale docs: replace `Implementation_Handoff.md` with a current snapshot; fix `README.md`, `Current_sprint.md`, `docs/handoff.md`, `gcp-deployment-guide.md` §8 and `Architecture.md` §17 (or mark them historical). | docs |
| P1-12 | Finish the ISSTD28 path required to leave the Sandbox: name Project Owner (G6+) and Accountable LT, RASCI, Legal/DPIA determination on prospect/client data, InfoSec re-score of the "persistent memory" trigger (browser TTL storage), logging retention/storage agreement. | `.wh-corp-production/workload.yaml`, `docs/production-promotion-plan.md` |

**P2**
| # | Task |
|---|---|
| P2-1 | Bound `sessionRegistry` (LRU/TTL, `sessionId` length cap) or remove the in-memory fallback once all clients send history. |
| P2-2 | Rate-limit and validate `/api/feedback` (id length, interaction existence, per-user cap). |
| P2-3 | Retrieval quality: light stemming (benchmark-gated), larger gold set seeded from real pilot questions and **reviewed by Content**, then decide on embeddings only if cross-language/paraphrase recall misses target. |
| P2-4 | Chunking: add section-level context to each chunk (document title + heading path in the indexed text), overlap, and treat transcripts as a separate source type with its own weight. |
| P2-5 | Distributed limits (shared store) if usage grows beyond the pilot, or accept per-instance semantics explicitly. |
| P2-6 | Telemetry analytics (BigQuery sink) and a Knowledge-Intelligence loop once real traffic exists. |
| P2-7 | Model lifecycle: pin versioned Gemini model, document upgrade/rollback procedure, track retirement date. |
| P2-8 | Google Chat channel and cross-session continuity, per the V1 decision, after launch. |

### Definition of Done: "100% production-ready" checklist

**Answer quality & safety**
- [ ] Generation parameters fixed and logged; same-code live-eval variance within an agreed band.
- [ ] Finding #005 enforced or formally accepted with a visible UI control; regression eval for scope, region, population, comparison-vs-cause and unsupported value language passes at the agreed thresholds.
- [ ] Claim verifier uses token-level matching; tests TS-010/TS-011 green.
- [ ] Prompt-injection, PII, and safety evals exist and pass; `safetySettings` configured.
- [ ] Over-ask 0%, must-ask ≥ Product-set bar, "Explain Wellhub"-class general questions ≥ bar on the full corpus.

**Knowledge**
- [ ] Automated governed Drive→GCS sync live; bucket age < 24 h; every served document is registered or explicitly policy-approved; zero Not-Eligible documents served; no ID collisions.
- [ ] Gold set reviewed by Content, ≥ 100 questions including real pilot traffic; Recall@5 and served R@5 ≥ Product's target, cross-language measured on ≥ 20 cases.

**Reliability & operations**
- [ ] Load test passed at the target concurrency with documented p95 latency and cost per turn.
- [ ] Abort/timeout semantics verified (TS-013, TS-015); knowledge base warmed at startup; readiness endpoint; no bare 500s before the stream.
- [ ] Alerts live for errors, latency, circuit-open, wrong provider, commit mismatch, registry staleness; on-call/coverage model named.
- [ ] Memory headroom ≥ 30% with the full corpus.

**Delivery & governance**
- [ ] Repo in the Wellhub GitHub org; CI runs type check, all tests including real-corpus benchmark, build, and a blocking dependency audit; deploy is automated and traceable to a commit; rollback rehearsed.
- [ ] `develop`, `main` and the deployed revision reconciled.
- [ ] All handoff/architecture documents reflect the running system.
- [ ] ISSTD28 approvals recorded (LT, InfoSec, ID, Legal/DPIA), data classification and retention agreed, training recertification current.

---

*Org rule check: no API key is used, suggested or required anywhere in this system or in this roadmap. Model access is by service identity (ADC) and content access by the service's attached identity, consistent with the managed-settings policy.*

## Progress log

### 2026-11-05: P0-1 to P0-4 and P1-1 to P1-4

| Item | Status | Notes |
|---|---|---|
| P0-1 generation parameters | Done | Explicit temperature, topP, bounded output; env overrides; logged at startup. Live eval baseline taken. |
| P0-2 Finding #005 | Done | Claims ledger enforced by default; AI-draft label already in the UI. Latency cost not yet measured in production. |
| P0-3 region from language | Done | pt→Brazil, de/fr/it/nl→Europe; en/es still ask. Caveat: Portuguese from Portugal is treated as Brazil until the user names the country. |
| P0-4 identity | Done | ID from the `[RKC-…]` file name; conflicts excluded. Four unregistered files still served (Product decision pending). |
| P0-4b Drive→GCS sync | Blocked | Needs IT to allow one service account as a sharing target. |
| P1-1 claim verifier | Done | Whole-number matching, percentages must be stated as percentages, value terms match as words, verification no longer depends on the model's self-tag (TS-010, TS-011 covered by tests). |
| P1-2 cancellation | Done | `signal` on the engine contract; the Gemini call is aborted on client disconnect or timeout, the timer is cleared, an abort is not a retry and does not count against the circuit breaker. The adapter's own abort path is not unit-tested (it needs the live SDK). |
| P1-3 pre-stream errors, warm-up | Done | Route wrapped so any pre-stream failure is logged and returned as a JSON 500; knowledge base warmed at startup; `/api/health?ready=1` returns 503 until loaded. |
| P1-4 memory headroom | Measured | Production corpus copy (266 MB on disk, 74 documents, 1,980 chunks): parse + index 2.4 s, peak RSS 228 MB (process baseline 73 MB) with `scripts/measure-ingest.ts`. Against the 2 Gi limit this is about 11% before the Next.js server and GCS download buffers; no change needed now. An RSS alert belongs with P1-5. |

### 2026-11-05 (later): deploy, P1-5, P1-6

- **Deploy:** `770f12b` is serving as `hubi-pilot-00009-8dc`; protected settings unchanged; verified from the startup event. P1-1 to P1-5 work is committed but not yet deployed.
- **P1-5 applied in part:** the five log-based metrics (`hubi_interaction_errors`, `hubi_rate_limited`, `hubi_circuit_open`, `hubi_wrong_provider`, `hubi_stale_registry`) now exist in `wh-revenue-sandbox`. Creating the email notification channel and the alert policies returned `PERMISSION_DENIED` (the account can create log metrics but not Monitoring notification channels or alert policies). Product chose email as the channel. Needs the Monitoring Editor role (or the Platform team) before the policies in `config/monitoring/policies.json` can be created.
- **P1-6 deferred by Product:** the repository stays under the personal GitHub account and deploys stay direct from `scripts/deploy.ts`. Revisit by requesting membership of the Wellhub org. The CI-driven deploy, and an automatic commit-mismatch alert, wait for that.

### 2026-11-05 (later): P1-7

- **Dependency audit was hiding real findings.** `npm audit --omit=dev` reported 5 advisories (1 critical, 2 high, 2 moderate), among them several Next.js remote-code-execution and cache-poisoning advisories in 16.3.2. The CI step was `continue-on-error`. Fixed with `npm audit fix` (next 16.3.2 to 16.4.5, within `^16`; sharp, source-map-js and semver patch bumps; `uuid` removed). Afterwards: 0 vulnerabilities, 525/525 tests, build passes, and a live Vertex call and a live abort both work (checked because `gaxios`, used by Google auth, changed version). The audit step is now blocking in `ci.yml`. **Not deployed yet**: the running revision still has the vulnerable Next.js.
- **Real-corpus tests in CI:** a synthetic fixture was not built. Those tests assert on real content (specific playbooks, regions, RKC ids), so a synthetic corpus would test different things under the same names. Every deploy already runs the full suite with the corpus present (`deploy.ts plan` shows `PASS tests`), so they do gate releases. CI now prints the skipped count so a growing number is visible. A fixture of synthetic structural cases can be added later if CI should catch those regressions before a deploy.

### 2026-11-05 (evening): UX fixes, deploy, P1-8

- **Regional applicability is internal:** removed from the answer text (prompt) and from the source list (an unknown region is never shown; named regions and Global still are). Deployed as `fd43fcf`, revision `hubi-pilot-00011-wnm`. Includes P1-1 to P1-5, the Next.js security fix and the earlier work. Product wants the whole source-metadata presentation reviewed when the front end is redesigned (the Google Chat surface in particular): see the recommendations in the session notes below.
- **P1-8 partly done:** `tests/chatRoute.test.ts` covers `/api/chat` input validation (400), the pre-stream failure path (structured JSON 500, no path leak), and the per-user rate limit (429 with Retry-After, per caller). These need no corpus or model, so they run in CI. Not done: the streamed happy path through the route (needs a synthetic corpus builder and an injectable engine) and a browser E2E; the live evals cover that behavior today.
- **Jira batch for permissions:** Monitoring Editor (alert policies and the email channel), Monitoring Viewer (dashboards), and the Drive sharing-target service account (P0-4b). Always-allocated CPU was dropped: Product chose to leave it for the pilot.
