# ARCHITECTURE.md

# Hubi Architecture

## Purpose

Hubi is designed as a modular AI Copilot platform for Wellhub Revenue.

The conversational experience is the first product surface built on top of a broader knowledge and guidance architecture.

This document describes the logical architecture of Hubi: its core layers, responsibilities, boundaries, and expected evolution.

It does not define the scope of a specific sprint, detailed infrastructure configuration, or final vendor choices.

Every implementation should preserve the principles described here so that Hubi can evolve without requiring major rewrites of its foundations.

---

# Architecture Goals

The architecture should enable Hubi to:

* answer direct Revenue questions;
* understand business situations and user objectives;
* ask for missing context before providing guidance;
* retrieve trusted information from the approved knowledge base;
* combine information from multiple approved documents;
* preserve traceability to original sources;
* support multi-turn conversations;
* guide users through documented processes;
* recommend relevant internal materials;
* evolve from local execution to a production environment on Google Cloud;
* support both a Web Application and Google Chat through the same core backend.

---

# Design Principles

The architecture should be:

* modular;
* maintainable;
* extensible;
* observable;
* grounded in trusted knowledge;
* independent from a specific interface;
* independent from a specific language model;
* prepared for future knowledge repositories and capabilities.

Individual components should evolve independently whenever reasonably possible.

Infrastructure choices should support the product architecture rather than define it.

---

# High-Level Architecture

Hubi is composed of the following logical layers:

```text
                     User
                       │
                       ▼
        Web Application or Google Chat
                       │
                       ▼
           Conversation Orchestrator
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
 Request Classification       Context Builder
          │                         │
          └────────────┬────────────┘
                       ▼
                Knowledge Engine
                       │
                       ▼
          Approved Knowledge Base
                       │
                       ▼
             Grounded Response Builder
                       │
                       ▼
      Answer · Sources · Materials · Next Step
```

Each layer has a clear responsibility and should remain as independent as reasonably possible.

---

# 1. User Interfaces

Hubi will support two user interfaces:

* Web Application;
* Google Chat.

## Web Application

The Web Application is the initial product interface.

It should support the complete conversational experience, including:

* starting a conversation;
* submitting questions or business scenarios;
* maintaining conversation history;
* displaying assistant responses;
* displaying source references;
* opening the original source material -- the WorkRamp Learner URL for training assets, the Google Drive URL otherwise (Section 6);
* presenting follow-up questions;
* presenting related materials;
* suggesting the next step.

The Web Application should remain visually simple, conversational, and focused on the user's current objective.

## Google Chat

Google Chat is the intended embedded interface for future production use.

It will allow Revenue teams to interact with Hubi within an existing Wellhub workflow without requiring users to adopt a separate tool for basic conversational access.

The Google Chat experience may be more concise than the Web Application because of interface limitations, but it should use the same conversation, retrieval, grounding, and response services.

## Interface Independence

The conversation and knowledge logic must remain independent from either user interface.

Neither the Web Application nor Google Chat should contain business rules, retrieval logic, or model-specific behavior.

Both interfaces should consume the same backend capabilities through defined application interfaces.

No mobile application, Slack integration, or Microsoft Teams integration is planned.

---

# 2. Conversation Orchestrator

The Conversation Orchestrator coordinates each interaction between the user and Hubi.

Its responsibilities include:

* receiving the user's message;
* retrieving the relevant conversation state;
* determining what kind of assistance the user needs;
* deciding whether additional context is required;
* invoking the appropriate knowledge services;
* assembling the information needed for response generation;
* preserving the continuity of a multi-turn conversation;
* coordinating the final response structure.

The Conversation Orchestrator should not contain Revenue business knowledge.

It coordinates the interaction but does not define commercial rules, pricing policies, process steps, or approved guidance.

---

# 3. Request Classification

Before retrieving information, Hubi should determine what the user is trying to accomplish.

The initial classification should remain simple and should not create unnecessary complexity.

Core request types include:

## Direct Question

The user asks for specific information.

Examples:

* “What is GDP?”
* “How long does Salesforce enrichment take?”
* “Which accounts are eligible for this feature?”

Expected behavior:

* retrieve the relevant approved information;
* answer directly;
* cite the source;
* provide related material only when useful.

## Business Scenario

The user describes a situation that requires contextual guidance.

Examples:

* “I have a prospect with offices in three countries.”
* “I need to structure a global offer.”
* “I am preparing for a conversation with a multinational client.”

Expected behavior:

* identify the objective;
* determine which contextual variables are missing;
* ask relevant follow-up questions;
* retrieve information only after enough context is available;
* provide grounded guidance, materials, and next steps.

## Decision Support

The user asks for help evaluating options.

Examples:

* “Can I offer a 60% discount?”
* “Should I use WH+ or GDP?”
* “Which package can I offer in this scenario?”

Expected behavior:

* retrieve the documented guidelines;
* identify required contextual variables;
* ask for missing information;
* present available documented options;
* explain requirements, approvals, and trade-offs;
* leave the final decision to the user.

Hubi must not create undocumented recommendations or decide on behalf of the user.

## Process Guidance

The user needs help completing a documented process.

Examples:

* “How do I create this opportunity in Salesforce?”
* “What fields do I need to complete?”
* “How should I request this approval?”

Expected behavior:

* retrieve the approved process;
* present the steps in the appropriate order;
* cite the source;
* indicate required approvals or escalation paths;
* avoid inventing missing steps.

The classification mechanism may evolve over time, but it should remain independent from the knowledge retrieval implementation.

---

# 4. Context Builder

The Context Builder determines whether Hubi has enough information to provide an accurate and useful response.

Its purpose is to prevent premature, incomplete, or assumed guidance.

Commercial processes may depend on variables such as:

* country;
* region;
* employee headcount;
* audience;
* client status;
* prospect versus existing client;
* client segment;
* pricing package;
* commercial model;
* number of countries;
* negotiation structure;
* product or SKU;
* approval threshold.

When essential context is missing, Hubi should ask the minimum number of questions necessary to proceed.

The Context Builder should:

* ask only relevant questions;
* avoid repeating information already provided;
* preserve answers during the active conversation;
* distinguish required context from optional enrichment;
* stop asking questions once enough information is available;
* avoid turning simple questions into unnecessarily long workflows.

The goal is accuracy without creating friction.

---

# 5. Knowledge Engine

The Knowledge Engine determines which approved information is required to answer the user or guide the conversation.

Its responsibilities include:

* retrieving relevant content from the approved knowledge base;
* using metadata to improve relevance;
* combining information from multiple approved documents when necessary;
* identifying conflicting or insufficient information;
* prioritizing the source of truth;
* considering document freshness and approval status;
* preserving traceability to original Google Drive sources;
* returning structured context for response generation.

The Knowledge Engine must not use:

* general internet search;
* Google Search;
* external websites;
* unapproved public sources;
* unsupported model knowledge;
* personal assumptions;
* undocumented business practices.

For organizational questions, Hubi may only use information available in the approved Revenue Knowledge Base.

---

# 6. Approved Knowledge Base

Hubi may only use content included in the approved Revenue Knowledge Base.

This knowledge base spans three distinct roles, which should not be treated as interchangeable:

1. **Canonical Hubi knowledge repository — Google Drive.** The Revenue Knowledge Center on Google Drive is the system of record for Hubi's structured knowledge assets: the authoritative documents, their taxonomy, ownership, and approval status. When Hubi combines information across documents or applies source-of-truth precedence (Section 8), this is the repository that precedence logic ultimately answers to.
2. **Learning source and citation destination for training assets — WorkRamp.** Training content (guides, recorded sessions, enablement material) is authored and published through WorkRamp, Wellhub's learning platform. For content that originates in WorkRamp, the correct citation destination is the WorkRamp **Learner URL** — the rep-facing link a Revenue employee can actually open — not a Google Drive link. WorkRamp is a citation target for this content type, not a competing or future repository (see Section 7).
3. **Prototype development copy — the local Content Repository.** During local development, the application does not have direct API access to either Google Drive or WorkRamp. The local `Content Repository` folder is a temporary, manually exported development copy used only so the prototype can run locally. It is not a fourth repository and must never be treated as the source of truth — see "Local Development Representation" below.

The source documents consist primarily of:

* process documentation;
* playbooks;
* commercial guides;
* pricing guidance;
* product and SKU materials;
* objection-handling materials;
* enablement and training documentation (WorkRamp-published);
* approved internal presentations and supporting assets;
* metadata maintained through the content management structure.

Hubi should preserve and display links to the correct original source whenever citing a source or recommending related content: the WorkRamp Learner URL for WorkRamp-originated training content, or the Google Drive URL for other Google Drive-native assets. Which URL is correct is determined by where the content actually originates, not by which system happens to be easiest to link to.

## Local Development Representation

During local development, the application may not have direct API access to Google Drive or WorkRamp.

Approved source documents may therefore be:

* manually downloaded or exported (e.g. as DOCX, matching the current prototype's real Content Repository);
* synchronized locally;
* converted into a locally processable representation.

The local representation may use plain text, structured JSON, HTML, DOCX, or another appropriate internal format. Confirmed in the current prototype: the real local Content Repository consists of DOCX exports following a consistent house template (a "Document Metadata" table plus a "Core Knowledge Body" section) — see Prototype_Plan.md for the ingestion pipeline built against this real structure.

This local processing format is an implementation detail.

It must preserve, whenever available:

* original document name;
* the correct original URL for the content's actual source (WorkRamp Learner URL for training assets, Google Drive URL otherwise);
* taxonomy;
* topic;
* audience;
* region;
* owner;
* approval status;
* source-of-truth status;
* creation date;
* last updated date;
* review date;
* expiration or review status.

The local copy must not replace Google Drive or WorkRamp as the source of truth for their respective content.

---

# 7. Knowledge Repositories

A knowledge repository is an approved internal system in which Wellhub Revenue knowledge is stored or published.

The initial repositories are:

* **Revenue Knowledge Center on Google Drive** — the canonical repository for Hubi's structured knowledge assets (Section 6).
* **WorkRamp** — the learning platform where training content is authored, published, and linked back to for citation (Section 6). WorkRamp is a confirmed, current-day repository role for training assets, not a hypothetical future integration.

Potential future repositories may include:

* Wellhub Wiki;
* other approved internal knowledge systems.

These are repositories, not external research sources.

Hubi must not perform open-web research.

A future repository should not be treated as automatically approved.

Each future connection must follow the applicable:

* security review;
* access review;
* data governance process;
* technical approval;
* content ownership model.

Adding a new repository should primarily require a new ingestion or repository adapter.

It should not require redesigning:

* the Web Application;
* the Google Chat interface;
* the Conversation Orchestrator;
* the request classification logic;
* the response generation logic.

---

# 8. Knowledge Precedence and Conflict Handling

Multiple documents may cover the same business concept.

For example, pricing information may appear in:

* a playbook;
* a training transcript;
* a launch deck;
* an FAQ;
* a regional guide.

The presence of multiple assets is expected.

Hubi should not assume that a topic has only one document.

When multiple sources provide complementary information, the Knowledge Engine may combine them into a single grounded response.

When sources conflict, Hubi should apply the following precedence:

1. approved source of truth;
2. most recently updated approved document;
3. content applicable to the user's region and audience;
4. explicit policy or process documentation over informal explanatory material.

If the conflict cannot be safely resolved, Hubi should:

* acknowledge the inconsistency;
* avoid silently selecting one version;
* cite the conflicting materials;
* recommend validation with the appropriate owner or SME.

Hubi must not invent a consolidated rule when approved sources disagree.

---

# 9. Retrieval Layer

The Retrieval Layer is responsible for finding the most relevant approved content for a user request.

Its implementation may change over time.

The local prototype may use:

* local document extraction;
* local chunking;
* keyword search;
* semantic search;
* local embeddings;
* a local vector index;
* metadata filtering.

The production version may use Google Cloud retrieval services or another approved architecture.

Regardless of implementation, the Retrieval Layer should support:

* semantic relevance;
* metadata filtering;
* audience filtering;
* region filtering;
* source-of-truth prioritization;
* freshness prioritization;
* retrieval across multiple documents;
* retrieval of source links;
* retrieval of related assets.

The Retrieval Layer should return structured evidence rather than a final user-facing answer.

---

# 10. Grounded Response Builder

The Grounded Response Builder transforms retrieved evidence and conversation context into the final user-facing response.

Its responsibilities include:

* answering the user's direct question;
* synthesizing information from approved sources;
* presenting guidance in a clear structure;
* explaining documented options;
* indicating required approvals;
* listing relevant process steps;
* citing original sources;
* recommending related materials when useful;
* suggesting an appropriate next step;
* clearly communicating uncertainty or missing information.

The Grounded Response Builder must not:

* introduce unsupported business rules;
* use external knowledge to complete gaps;
* recommend actions based on personal judgment;
* hide uncertainty;
* omit material conflicts;
* present inferred information as documented fact.

---

# 11. Response Model

Hubi responses should be adapted to the user request rather than forced into one rigid template.

Possible response elements include:

## Direct Answer

A clear answer to the user's immediate question.

## Key Considerations

Relevant rules, constraints, or contextual factors.

## Options

Documented alternatives available to the user.

## Process Steps

Sequential guidance based on an approved process.

## Required Approvals

Any approval requirements explicitly stated in the source materials.

## Sources

Short references linked to the original Google Drive documents.

Sources should resemble compact citation references rather than large excerpts.

## Related Materials

Relevant decks, calculators, templates, guides, trainings, or playbooks.

## Next Step

A practical continuation of the task.

Example:

“Would you like me to guide you through the Salesforce opportunity setup?”

Not every response requires every element.

Simple questions should receive simple answers.

Complex situations may require a richer response.

---

# 12. Conversation State

Hubi should support multi-turn conversations.

Conversation state should allow Hubi to:

* remember information shared earlier in the current conversation;
* avoid asking the same contextual question twice;
* understand follow-up questions;
* refine prior guidance;
* continue a documented workflow;
* maintain source and topic continuity.

The initial implementation may maintain conversation state only during the active local session.

The production implementation may persist conversation history according to approved security, privacy, and retention policies.

Persistent cross-session memory is not required for the initial architecture.

Conversation history and long-term user memory should remain separate concepts.

---

# 13. Model Abstraction

Hubi should not be permanently coupled to one language model.

The architecture should use a defined model interface for tasks such as:

* request classification;
* follow-up question generation;
* grounded answer generation;
* response formatting;
* future knowledge extraction.

The initial implementation may use the model that is technically available for local development.

The production implementation may use Gemini through Vertex AI or another approved provider.

Changing the model provider should not require redesigning the user interface, knowledge layer, or core product logic.

Model-specific prompts and configurations should be isolated.

---

# 14. Interface and Application Boundaries

The frontend should be responsible for:

* displaying the initial conversational screen;
* rendering message history;
* collecting user input;
* displaying loading and streaming states;
* rendering citations;
* rendering related materials;
* rendering suggested follow-ups;
* handling basic client-side interaction.

The backend should be responsible for:

* conversation orchestration;
* request classification;
* context management;
* knowledge retrieval;
* model invocation;
* grounding;
* response generation;
* source mapping;
* error handling.

The frontend should not directly:

* access the knowledge repository;
* call the language model;
* contain commercial rules;
* determine source precedence.

## 14.1 Current implementation of this boundary — CONFIRMED

The Web Application (a Next.js app under `app/`) implements this boundary as follows:

- **Frontend** (`app/page.tsx`, a client component): renders messages, collects input, opens a streamed HTTP request, renders incremental text as it arrives, renders citations and clarifying-question/no-answer visual states, and collects Helpful/Not-helpful feedback. It contains no business rules, no retrieval logic, and never calls the reasoning engine or knowledge base directly.
- **Backend** (`app/api/chat/route.ts`, `app/api/feedback/route.ts` — Next.js Route Handlers running in the **Node.js runtime**, not Edge, since the chat route spawns the `claude` CLI via `child_process` and Edge cannot do that): owns retrieval, session state, prompt building, the reasoning engine call, citation selection, and logging. These routes are thin adapters over the same `lib/ingestion`, `lib/retrieval`, and `lib/runtime` modules used by the terminal tool (`scripts/ask.ts`) — no business logic was duplicated for the web UI.
- **Transport between them:** the chat route streams NDJSON (newline-delimited JSON) over a chunked HTTP response — one `retrieval` event (chunk count + sources), then one `delta` event per real incremental token as it arrives from Claude Code, then one `done` event (ok/error, latency, `turnKind`, `interactionId`). This mirrors the same event-shape reasoning the codebase already uses for Claude Code's own `stream-json` output, so the mental model is consistent end to end. The frontend never parses or depends on Claude Code's own output format directly — only this NDJSON contract.
- **A long-lived process changes one thing versus the terminal tool:** ingestion and index-building happen once per server process (a lazy singleton, `lib/runtime/knowledgeBase.ts`), not once per invocation. Session State (`lib/runtime/sessionState.ts`) is kept server-side in an in-memory registry keyed by a browser-generated session id stored in `sessionStorage` — matching Section 12's "active session only" scope exactly (no cross-browser-session persistence, no accounts).

---

# 15. Local Architecture

The initial prototype should run locally on a Wellhub-managed computer.

The local architecture should support:

* a locally hosted Web Application;
* a local backend service;
* locally processed copies of approved source documents (see Section 6's three-role model: Google Drive, WorkRamp, and the local Content Repository);
* a local searchable knowledge index;
* local conversation state;
* clickable links to the correct original source (WorkRamp Learner URL or Google Drive URL, per Section 6).

The local prototype does not require:

* direct Google Drive API access;
* Google Chat integration;
* production authentication;
* Salesforce integration;
* WorkRamp integration;
* write access to any Wellhub system;
* cloud hosting.

However, the local implementation should preserve clean boundaries so these capabilities can be added later.

---

# 16. Production Architecture Direction

The production version is expected to run on Google Cloud Platform.

The final service selection will be validated with the relevant Platform and InfoSec teams.

Expected production capabilities may include:

* Web Application hosting;
* Google Chat integration;
* controlled read access to the Revenue Knowledge Center;
* secure service accounts and IAM;
* Secret Manager;
* managed conversation services;
* managed retrieval or vector search;
* application monitoring;
* audit logging;
* usage analytics;
* cost monitoring;
* controlled content ingestion.

The production architecture should not rely on manually distributed API keys.

Authentication and service access should follow Wellhub-approved IAM and service-account patterns.

---

# 17. Security and Data Boundaries

Hubi is a read-only knowledge and guidance application in its initial implementation.

It should not:

* modify Salesforce;
* modify Google Drive source documents;
* send external communications;
* create Jira tickets;
* execute financial actions;
* change system configuration;
* make decisions on behalf of users.

The initial knowledge base should not intentionally contain:

* client-specific records;
* personal employee data;
* sensitive transactional data;
* credentials;
* secrets;
* production system exports.

Only approved internal Revenue knowledge should be processed.

Any future expansion into client data, operational systems, or automated actions will require separate review.

## 17.1 Web UI prototype access model — CONFIRMED

For the current prototype testing phase, Hubi's web UI is reachable **only via `127.0.0.1` (localhost) on the machine it runs on** — `next dev`/`next start` are explicitly launched with `--hostname 127.0.0.1` (see `package.json`), not the framework default, which binds every network interface and would otherwise expose the app to the corporate network. This was caught during this milestone's own browser testing (the dev server's own startup log showed a LAN-reachable address before the fix) — confirming the fix by re-checking that log, not just by reading the flag's documentation, mattered.

Validation stages, in order: (1) internal project-team testing on the local machine, (2) moderated Revenue rep testing via screen-share or remote-control access to that same machine — reps do not independently reach Hubi from their own devices during this phase. No authentication or access-control work has been built, because none is needed under this access model; introducing independent rep access from other devices would change that and must be revisited before it happens, not assumed.

Interaction logs (`logs/interactions.jsonl`) capture no personal data beyond a random per-browser-session UUID — no names, no IP addresses, no browser fingerprinting. The logged question/response content is real Wellhub Revenue business content by nature of what Hubi answers, and should be handled with the same care as the knowledge base itself; the log directory is gitignored.

## 17.2 Model self-report is not independent verification — accepted prototype debt

The UI's "Hubi needs more context" and "No grounded answer found" visual states are derived from Claude Code's own trailing self-report tag (`lib/runtime/turnKind.ts`), not from independent classification. This is intentional, approved prototype technical debt — see `Prototype_Plan.md` for the full rationale and the safeguards in place (a missing or malformed tag never breaks the response; the tag itself is never shown; the default visual treatment is neutral when the turn kind can't be determined). Any observed mis-tagging during testing is a real signal worth capturing, not a silent failure mode — the testing guide asks reviewers to note it.

---

# 18. Observability

The architecture should support visibility into product and system performance.

Over time, Hubi should be able to monitor:

* user questions;
* request categories;
* retrieved sources;
* response latency;
* model errors;
* retrieval failures;
* unanswered questions;
* fallback events;
* source usage;
* frequently accessed content;
* user feedback;
* cost and token usage.

Observability should support both technical reliability and knowledge improvement.

Logging must follow approved privacy, security, and retention policies.

---

# 19. Failure Handling

Hubi should fail safely.

If the language model is unavailable, Hubi should communicate that the response cannot currently be generated.

If no relevant approved knowledge is found, Hubi should say so clearly.

If retrieved information is conflicting, Hubi should identify the conflict.

If a source link is unavailable, Hubi should avoid presenting it as accessible.

If the conversation state is lost, Hubi should ask the user to restate the essential context.

Hubi must not compensate for technical or content failures by inventing an answer.

---

# 20. Future Capabilities

Future capabilities should extend the existing architecture instead of replacing it.

Potential future capabilities include:

* personalized homepage;
* knowledge exploration;
* learning paths;
* guided commercial workflows;
* advanced decision support;
* content governance;
* content lifecycle management;
* knowledge health analytics;
* unanswered-question workflows;
* WorkRamp ingestion;
* Wiki ingestion;
* controlled Salesforce read access;
* calculators and pricing tools;
* approved operational actions.

These are not requirements for the current prototype.

They define the direction the architecture should be able to support.

---

# Architecture Goal

Hubi should evolve by adding capabilities, not by rebuilding foundations.

The conversational experience, knowledge model, retrieval services, and infrastructure should remain sufficiently separated so that each can improve independently.

A well-designed Hubi architecture should allow:

* new interfaces without duplicating business logic;
* new repositories without redesigning the conversation;
* new models without rebuilding the product;
* new capabilities without fragmenting knowledge;
* local development to evolve into production deployment.

The architecture exists to make Hubi easier to evolve, not more complicated to build.
