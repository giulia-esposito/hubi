# Hubi

Wellhub Revenue's AI Copilot — local prototype.

Hubi's product vision, principles, and architecture are documented separately and are the stable reference for *why* things are built this way:

- [`CLAUDE.md`](CLAUDE.md) — product philosophy and engineering principles (stable, changes slowly)
- [`Product.md`](Product.md) — product requirements
- [`Product_Architecture.md`](Product_Architecture.md) — **the primary conceptual reference**: how Hubi understands context, applicability, and knowledge governance, and its relationship to the Knowledge Center Content Registry
- [`Conversation_Continuity_Architecture.md`](Conversation_Continuity_Architecture.md) — how Hubi lets users continue prior work across sessions and channels (Web App, Google Chat) without ever confusing business contexts
- [`Implementation_Handoff.md`](Implementation_Handoff.md) — status snapshot and recommended next milestone for a new conversation picking up this project
- [`Architecture.md`](Architecture.md) — target logical/technical architecture (all layers, including ones not built yet)
- [`Current_sprint.md`](Current_sprint.md) — this sprint's scope and definition of done
- [`Prototype_Plan.md`](Prototype_Plan.md) — current implementation state, validated results, and history
- [`docs/testing-guide.md`](docs/testing-guide.md) — for internal reviewers and Revenue reps testing the prototype
- [`docs/handoff.md`](docs/handoff.md) — for another engineer picking this up
- [`docs/validation-findings.md`](docs/validation-findings.md) — the running log of product validation findings from testing
- [`docs/logging-foundation.md`](docs/logging-foundation.md) — design proposal for what the interaction log should capture long-term
- [`docs/context-applicability-architecture.md`](docs/context-applicability-architecture.md) — context, applicability, and multilingual retrieval architecture proposal
- [`docs/gcp-deployment-guide.md`](docs/gcp-deployment-guide.md) — how to run Hubi's runtime on GCP (Cloud Run + Gemini via Vertex AI + Cloud Storage) for the pilot. Claude Code remains the engineering environment; only the deployed runtime's reasoning engine and content source change.
- [`docs/migration-validation-checklist.md`](docs/migration-validation-checklist.md) — regression checklist for comparing Claude Code vs. Gemini behavior before deploying

This file is the practical "how do I run it" entry point.

## Current state

A one-screen Next.js web UI wraps the validated pipeline: DOCX ingestion → lexical retrieval → session-aware prompt building → Claude Code reasoning (real token streaming) → grounded, cited responses, with multi-turn continuity, clarifying questions, and an honest "I don't know" when the knowledge base doesn't support an answer. It also captures Helpful/Not-helpful feedback and a local interaction log for product validation. **Internal prototype, local only** — see `docs/testing-guide.md` for the intended test model before running this with anyone else in the room.

The original terminal tool (`scripts/ask.ts`) still exists and still works — useful for quick debugging without a browser.

## Prerequisites

- **Node.js 22.6+** (developed and tested on 24.18.0). If you can't install Node normally (e.g. no admin rights on a corporate machine), use the official **portable ZIP** distribution from nodejs.org: extract it anywhere writable (e.g. `%USERPROFILE%\.local\nodejs`) and add that folder to your **user** PATH (`setx PATH` or `[Environment]::SetEnvironmentVariable(...,"User")` in PowerShell) — no admin rights or installer required.
- **Claude Code CLI**, installed and authenticated (`claude auth login`). Verify with `claude auth status`.
- **npm registry access**, to install Next.js/React (see below). Confirm with `npm ping`.

The ingestion/retrieval/runtime core (`lib/`) has **zero npm dependencies** — everything there is built on Node's standard library. Next.js and React are the *only* runtime dependencies in this project, added specifically for the web UI.

## Setup

```bash
npm install
```

## Reasoning engine and content source (provider selection)

Hubi's reasoning engine and knowledge-file source are each selected by an environment variable, defaulting to exactly what this project has always done locally — **you do not need to set anything to develop with Claude Code as before.**

Copy [`.env.example`](.env.example) to `.env.local` if you want to override a default:

- `HUBI_REASONING_PROVIDER` — `claude-code` (default; spawns the local `claude` CLI, requires `claude auth login`) or `gemini` (Vertex AI — the Cloud Run pilot runtime; see [`docs/gcp-deployment-guide.md`](docs/gcp-deployment-guide.md)).
- `HUBI_CONTENT_SOURCE` — `local` (default; reads the local `Content Repository/` folder) or `gcs` (downloads from a Cloud Storage bucket at startup).

Both `npm run dev` and `npm run ask` respect these. To compare the two reasoning engines locally, for example:

```bash
npm run ask -- "What discount can I offer an Enterprise client in Brazil?"
HUBI_REASONING_PROVIDER=gemini npm run ask -- "What discount can I offer an Enterprise client in Brazil?"
```

The Gemini path requires `GOOGLE_CLOUD_PROJECT` set and either `gcloud auth application-default login` run locally, or (on Cloud Run) the deployed service's attached identity — never a manually distributed API key.

## Running the web UI

```bash
npm run dev
```

Open **http://127.0.0.1:3000**. The server binds to `127.0.0.1` only (not your network interface) — see `Architecture.md` for why, and do not change this without re-reading the security section there.

For a closer-to-production run:

```bash
npm run build
npm run start
```

Both commands also bind to `127.0.0.1` only.

## Running the terminal tool

```bash
# Ingest the real Content Repository and print a report (documents, chunks, warnings)
npm run ingest

# Ask Hubi one question and exit
npm run ask -- "What should I do to prepare cadences in Salesloft?"

# Or start an interactive multi-turn session
npm run ask
```

## Testing

```bash
npm test
```

Runs the regression suite (`tests/*.test.ts`) via Node's built-in test runner — no test framework dependency. It covers ingestion correctness against the real 15-document corpus, chunk generation, BM25 retrieval mechanics and gap handling, and citation formatting. It does **not** call the live Claude Code CLI or exercise the web UI (kept deterministic, fast, and independent of auth/network) — reasoning-engine and UI behavior are validated via `scripts/validate-phase0.*` and manual scenario testing, documented in `Prototype_Plan.md`.

For the internal/rep testing process itself (not automated tests), see `docs/testing-guide.md`.

## Validating the Reasoning Engine (Phase 0)

Before relying on Claude Code as the Reasoning Engine on a new machine, run the Phase 0 validation script and confirm it reports `PASS`:

```bash
# If Node is available
npm run validate-phase0

# Native PowerShell equivalent (no Node required) -- see scripts/validate-phase0.ps1
npm run validate-phase0:windows
```

Full methodology and the last confirmed result are in `Prototype_Plan.md`.

## Repository structure

```
Hubi/
  app/
    page.tsx                     The one conversational screen
    layout.tsx                    Root layout + prototype banner
    globals.css                   Plain CSS, no UI library
    api/
      chat/route.ts                 Streams one turn as NDJSON
      feedback/route.ts             Logs Helpful/Not-helpful feedback
  lib/
    ingestion/       DOCX parsing, template-aware normalization, chunking (zero-dependency),
                       and contentSource.ts (local folder or GCS, see docs/gcp-deployment-guide.md)
    retrieval/        In-memory BM25 lexical index
    runtime/          Session State, Prompt Builder, Reasoning Engine adapters (Claude Code +
                       Gemini/Vertex AI) behind a provider-selecting interface, Citation Builder,
                       knowledge-base singleton, session registry, interaction log, turn-kind tagging
  Dockerfile          Cloud Run production image (never used by local `npm run dev`)
  scripts/
    ask.ts                    Terminal entry point (single question or interactive REPL)
    test-ingestion.ts         Ingestion report CLI
    validate-phase0.mjs       Phase 0 validation (Node)
    validate-phase0.ps1       Phase 0 validation (native PowerShell, no Node required)
    dev.cmd                    Dev-server launch wrapper (sets PATH for the portable Node runtime)
  tests/              Automated regression suite (node:test)
  logs/               interactions.jsonl -- local, inspectable, gitignored
  Content Repository/ Local development copy of the real Revenue Knowledge Center export (DOCX)
```

## Where logs go

Every chat turn and feedback submission is appended to `logs/interactions.jsonl` (one JSON record per line, gitignored, never uploaded anywhere). No personal data beyond a random per-browser-session UUID is captured. See `docs/testing-guide.md` for what each field means and `Architecture.md` for the security rationale.
