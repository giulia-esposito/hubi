# Technical Handoff

For another engineer picking this project up. This is a map and a set of pointers, not a duplicate of the full history — read `Prototype_Plan.md` for that.

## What this is, in one paragraph

A local Next.js prototype of Hubi, Wellhub Revenue's AI Copilot. A single conversational screen calls a Next.js API route that: retrieves relevant chunks from a real 602-chunk knowledge base (BM25 lexical search, no embeddings), builds a grounded prompt with conversation history, calls Claude Code (via its CLI, spawned as a child process) as the Reasoning Engine with real token streaming, and renders the answer with citations. It also collects Helpful/Not-helpful feedback and logs every interaction locally. No auth, no database, no deployment — everything runs on one machine, for facilitator-led internal/rep testing.

## Get it running

1. Node.js 22.6+ and the `claude` CLI, authenticated. See `README.md` if either needs a no-admin-rights workaround.
2. `npm install` (only real dependencies: `next`, `react`, `react-dom`; devDependencies: `typescript`, `@types/node`, `@types/react` — **pin `typescript` to a stable 5.x release**, not `latest`; `npm install typescript` resolved to a `7.0.x` pre-release build during this milestone that broke Next.js's type-checking step in ways that weren't obvious from the error message).
3. `npm run dev` → http://127.0.0.1:3000. `npm test` → the offline regression suite.
4. `npm run validate-phase0` (or `:windows` for the no-Node PowerShell version) if you need to re-confirm the Reasoning Engine is working on a new machine.

## Where the actual logic lives

`app/api/chat/route.ts` and `app/api/feedback/route.ts` are thin adapters — read them first, they're short. All real logic is in `lib/`:

| Module | Responsibility |
|---|---|
| `lib/ingestion/*` | DOCX → structured document → chunks. Zero dependencies (DOCX is a ZIP of XML; built on Node's `zlib`). |
| `lib/retrieval/index.ts` | BM25 lexical index over chunks. |
| `lib/runtime/sessionState.ts` | Conversation `Session`/`Turn`, `accumulatedUserQuery()`. |
| `lib/runtime/sessionRegistry.ts` | Server-side `Map<sessionId, Session>` — the web layer's session store. |
| `lib/runtime/knowledgeBase.ts` | Lazy singleton: ingest + build index once per server process, not per request. |
| `lib/runtime/promptBuilder.ts` | Grounded prompt + system prompt (includes the turn-kind self-tagging instruction). |
| `lib/runtime/reasoningEngine.claudeCode.ts` | Spawns `claude`, streams live, applies Phase-0-confirmed isolation flags. |
| `lib/runtime/turnKind.ts` | Strips the model's trailing self-report tag; never leaks it; defaults to neutral on absence/malformation. |
| `lib/runtime/citationBuilder.ts` | Terminal-tool citation string formatting (the web UI renders the same rule as JSX directly in `app/page.tsx`, not by reusing this string formatter). |
| `lib/runtime/interactionLog.ts` | Appends JSONL records to `logs/interactions.jsonl`. |

`scripts/ask.ts` is the original terminal tool — still works, still useful for debugging without a browser, and shares every one of the modules above.

## Things that will surprise you if you don't know them going in

1. **`next dev`/`next start` must keep `--hostname 127.0.0.1`.** The framework default binds every network interface. This was live and LAN-reachable for a few minutes during this milestone's own testing before it was caught — don't remove the flag without re-reading `Architecture.md` Section 17.1.
2. **React Strict Mode double-invokes setState updater functions in development.** Every message-list update in `app/page.tsx` must return a *new* object for the message being changed, never mutate the previous one in place — an in-place mutation (`message.text += delta`) gets applied twice under Strict Mode and silently duplicates streamed text. Already fixed once; don't reintroduce it.
3. **`turnKind` is a model self-report, not a classifier.** `lib/runtime/turnKind.ts` strips Hubi's own trailing tag (`[[HUBI:GROUNDED_ANSWER]]` etc.) from its response. This is accepted prototype debt, not a bug — see `Prototype_Plan.md` for the full reasoning. It degrades safely: missing or malformed tags never break the response and default to a neutral UI treatment.
4. **Claude Code's authenticated identity can leak into responses** even with all isolation flags applied (it once addressed the user by the logged-in account holder's first name). `HUBI_SYSTEM_PROMPT` now explicitly instructs against this. If you see personalized responses creep back in, that instruction is the first place to look.
5. **Ingestion happens once per server process**, not per request (`lib/runtime/knowledgeBase.ts`). If you edit `Content Repository/` content and don't see it reflected, restart the dev server.
6. **The regression suite (`npm test`) never calls the live Claude CLI.** Deliberate — keeps it fast, deterministic, and independent of auth/network. Reasoning-engine behavior is validated via `scripts/validate-phase0.*` and manual scenario testing, not CI-style automation.

## Known limitations / accepted debt (full detail in `Prototype_Plan.md`)

- Pure lexical retrieval is weaker on long unstructured transcript documents.
- No session eviction (in-memory `Map`, fine for a short local test window, not for a long-running server).
- Latency is only smoke-tested, not profiled.
- `turnKind` self-tagging (see above).
- A transitive `postcss` advisory ships inside Next.js's own build tooling; fixing it means downgrading Next.js to v9 (`npm audit fix --force`) — not worth it for a build-time-only, non-deployed issue. Left as-is, monitored.

## If you need the full history

`Prototype_Plan.md` is written current-state-first, with the full validation/correction narrative (including every bug found and how it was fixed) preserved in its Appendices. `Architecture.md` describes the target architecture this prototype is building toward; not everything there is implemented yet, and it says so where relevant.
