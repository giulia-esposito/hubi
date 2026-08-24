# Hubi — Conversation Continuity Architecture

**Version 1 (final).** A conceptual architecture document, consistent with and subordinate to `Product_Architecture.md` (product/knowledge concepts) and `Architecture.md` (the Runtime architecture — Conversation Orchestrator, Context Builder, Knowledge Engine, and the other Runtime components this document assumes and extends). No implementation details, algorithms, or code.

---

## Purpose

Conversation Continuity lets a user naturally pick up work they started earlier — in the same channel or a different one — without Hubi ever confusing which business situation that work belongs to.

It is explicitly **not** AI memory, not long-term memory, and not retrieval of previous answers. Those framings all describe an *implicit* mechanism: a model that quietly retains and blends whatever it has seen before. Conversation Continuity is the opposite — an *explicit, resolved, governed* decision about whether a specific piece of prior work is safe to reattach to the current interaction. Nothing is carried forward by default. Everything carried forward has passed a compatibility check first.

Conversation Continuity reduces friction. It must never introduce assumptions.

---

## Principles

The architectural principles you stated, unchanged, are the foundation this entire design sits on:

- The Knowledge Center remains the single source of truth.
- Conversation history is never a source of business facts.
- Business Context always overrides Conversation Context.
- Knowledge Retrieval always uses the latest approved knowledge.
- Governance always precedes reasoning.
- Conversation Context exists only to preserve work continuity.

**Formalized further, because it's the load-bearing rule for everything below:**

**Compatibility, not similarity, authorizes continuity.** Two conversations can be topically similar — both about onboarding, both about pricing — while belonging to entirely different, non-transferable business situations. Similarity is a property of *text*. Compatibility is a property of *business context*. Only compatibility may authorize reuse. This is the same category of mistake as "language is not applicability," discovered earlier in Hubi's knowledge retrieval work — a surface-level resemblance mistaken for the deeper fact that actually determines correctness.

**The guiding principle for transparency:**

> Conversation continuity should be seamless within an active context, transparent when resuming previous work, and explicit only when uncertainty exists.

Continuity is not one behavior — it is three, deliberately different:

- **Within an active context, it is silent.** If the user is clearly continuing the current conversation, Hubi simply continues. Announcing this on every turn would make Hubi feel like a chatbot managing sessions instead of an assistant having a conversation.
- **When resuming previous work after a meaningful interruption** (a different session, a different channel, or a significant context break), Hubi briefly says so — *"Picking up from your previous ABC onboarding discussion..."* — because the user should always know when older context has re-entered the conversation, even if they don't need to approve it.
- **When genuinely uncertain** — more than one previous conversation could plausibly apply, or there's a real risk of mixing business contexts — Hubi asks before reusing anything.

Transparency scales with the stakes of the decision, not with every decision equally.

---

## The Important Distinction, Formalized

| | Knowledge Retrieval | Conversation Continuity |
|---|---|---|
| Retrieves | Official business knowledge (pricing, onboarding process, policy, product information, governance) | The user's own previous work (drafts, open questions, unfinished plans, uploaded documents, generated artifacts, prior decisions, conversation goals) |
| Source of truth | Knowledge Center Content Registry | The user's own conversation history — never promoted to business fact |
| Authority | Knowledge Center (governance-owned) | The user, and Hubi's Conversation Governance (Hubi-owned) |
| What it can never do | Be bypassed by conversation history | Be treated as a source of business facts, regardless of how confident it sounds |

A resumed conversation can hand Hubi a *reminder of what the user was working on*. It can never hand Hubi *a fact about the business*. Every answer still passes through Knowledge Retrieval, the Applicability Layer, and Reasoning exactly as if the conversation were brand new — continuity changes what context is available to ask about, never what's true.

---

## Core Concepts

- **Conversation** — a bounded unit of work with a coherent business context. Not the same thing as a Google Chat thread or a browser session; those are channel-specific *access points* into a conversation, not the conversation itself.
- **Conversation Store** — the shared, channel-agnostic record of a user's conversations: their history, their Context Scopes, their work artifacts, and their lifecycle state. One store, consumed identically by every channel.
- **Context Scope** — one dimension along which two conversations may be compatible. Not every conversation has every scope; only the scopes that actually exist for a given conversation participate in its compatibility evaluation.
- **Conversation Resolution** — the layer that decides, before anything else happens, whether to continue, resume, ask, or start fresh.
- **Context Isolation** — not a separate mechanism, but the *guarantee* that Conversation Resolution and Conversation Governance together are responsible for upholding: no conversation's context ever silently leaks into a different business context's answer.
- **Conversation Governance** — the domain of Hubi's existing Governance concept responsible for conversations specifically: ownership, privacy, compatibility rules, and controlled backoffice access. A domain of Governance, not a second, unrelated concept that happens to share the name.

---

## Compatibility as Context Scopes

Not every conversation has a client. Some relate to internal processes, product information, governance, training, documentation, global initiatives, specific regions, uploaded documents, or a named customer — and some relate to several of these at once, or none in any strong sense. A mandatory hierarchy would force every conversation into a shape most of them don't have. Compatibility is instead evaluated as a **collection of independent scopes**, only some of which apply to any given conversation:

- **Identity Scope** — who the conversation belongs to (and, potentially, who else it involves). Establishes ownership and access, not automatic context reuse by itself.
- **Business Entity Scope** — the client, account, subsidiary, customer, or internal business entity involved, if any.
- **Initiative Scope** — the project, program, launch, or global initiative the conversation relates to, if any.
- **Task Scope** — the specific objective or artifact within that initiative — a draft, a decision, a question being worked through.
- **Temporal Scope** — how recent the conversation is. Never a compatibility signal on its own; a *confidence modifier* on the others (see "Time," below).

Two conversations are compatible when, across the scopes that actually exist for both, nothing conflicts and enough substantively matches for the current question. A conversation with no Business Entity Scope at all (a general policy question, say) is simply not evaluated on that axis — its absence is not a mismatch.

**Explicit context always outranks inferred context.** If a user has stated a scope value directly ("this is for Client ABC"), that value is authoritative. If Hubi has only inferred a scope value — from the flow of conversation, or from an uploaded document — that value carries less weight, and any conflict between an explicit and an inferred value resolves in the explicit one's favor. When confidence in an inferred value is insufficient to proceed safely, Hubi asks rather than assumes.

---

## Conversation Resolution

Conversation Resolution is Conversation Continuity's equivalent of the Applicability Layer — same design pattern (deterministic first, ask when ambiguous, never silently assume), different domain (which conversation is in play, rather than which knowledge is eligible). It runs *before* the Context/Applicability flow described in `Product_Architecture.md` even begins.

**Decision flow, with the transparency behavior that belongs to each outcome:**

1. **Active conversation, no contradicting signal** → **Continue**, silently. This is the default, lowest-friction path — most single-session interactions never leave it.
2. **No active conversation, but the current message's Context Scopes match a previous conversation's** (not just topically similar — substantively compatible across the scopes that exist) → **Resume**, with a brief, visible acknowledgment of what's being picked back up. Its work history becomes Conversation Context — reference material, never business fact.
3. **Genuinely ambiguous** — more than one prior conversation could plausibly apply, a scope value can't be confirmed, or two scope values conflict → **Ask**, before reusing anything. *("Is this about the same onboarding we discussed for Client ABC, or a different one?")*
4. **Signals clearly indicate a different or new business context**, or the user explicitly invokes Start Fresh → **Start a new conversation.** Knowledge Retrieval rebuilds entirely from current Knowledge Center content; nothing about the previous conversation's retrieved knowledge or generated answers carries forward.

**Business Context still overrides everything, even mid-resumption.** If a resumed conversation's history suggests one context but the user's current message states something different, the current statement wins immediately — resuming a conversation offers a starting point, never a lock-in.

---

## Context Isolation, Restated as a Guarantee

Context Isolation is what Conversation Resolution and Conversation Governance jointly guarantee, not a third mechanism sitting beside them: **a business context is never automatically inherited across a compatibility boundary.** Client ABC's onboarding conversation is never silently continued when the user starts talking about Client XYZ, no matter how similar the topic. At most, Hubi may reference "you have a previous conversation about a similar topic for a different client" as a work-history pointer — never as content that informs the current answer. If this guarantee is ever violated, that is a Conversation Resolution defect, not a separate "isolation" feature to build independently.

---

## Conversation Governance

Governance is one overarching concept with two domains, under two different authorities:

| | Knowledge Governance | Conversation Governance |
|---|---|---|
| Governs | Knowledge Assets | Conversations |
| Authority | Knowledge Center Content Registry | Hubi itself |
| Decides | Eligibility, lifecycle, usage policy | Ownership, privacy, compatibility rules, backoffice access |

**Decided for V1:**
- Conversation history is private to each user by default.
- Initially, exactly **one** authorized Hubi administrator has backoffice access, for troubleshooting, quality review, adoption analysis, knowledge-gap identification, and product improvement. Expanding beyond one is a later decision, not a V1 concern.
- Conversation history **never** becomes organizational knowledge automatically. If a conversation reveals a genuine Knowledge Demand or gap, that insight travels through the *existing* Knowledge Intelligence loop (`Product_Architecture.md`, Section 1) back to the Knowledge Center for a human governance decision — it does not get a separate, redundant path.
- Retention is **indefinite for now**, to support product learning and continuous improvement. Retention policy may evolve later, the same way it's already an open question for interaction logs (`docs/logging-foundation.md`).

---

## Lifecycle

```
Created ──► Active ──► Continued / Resumed (elsewhere, later) ──► Closed ──► Archived
```

- **Created**: a new logical conversation begins, with whichever Context Scopes are established at the time — possibly none yet.
- **Active**: the current, in-progress conversation for its channel.
- **Continued / Resumed**: the same logical conversation persists across turns, or is picked back up later via Conversation Resolution.
- **Closed**: ended explicitly (Start Fresh) or implicitly by prolonged inactivity. History is preserved either way — closing is never deleting.
- **Archived**: retained indefinitely for Web App history and governed backoffice access.

**Time is a confidence modifier, never a determinant.** Elapsed time reduces confidence in automatic resumption — the longer since a conversation was active, the more readily Resolution should move from "Resume" toward "Ask" rather than assuming compatibility still holds. But elapsed time never by itself decides that continuity is inappropriate, and it never overrides explicit user intent: if the user clearly signals they're continuing something from months ago, that intent wins regardless of how much time has passed.

---

## Web App Behavior

The Web App is Hubi's full experience: conversation history, rename, delete, favorites, user-defined folders, search, and direct access to any previous conversation. No predefined workspace types — a single conversation may legitimately drift from onboarding into pricing into launch readiness into communications, because that's how real Revenue work actually moves. Folders organize by whatever the user finds useful, not by a taxonomy Hubi imposes.

## Google Chat Behavior

Google Chat should feel like talking to a colleague who remembers what you were working on — not like managing sessions. Conversation Resolution runs automatically on every message, with the three-tier transparency behavior described above:

- Same business context → continues naturally, silently.
- Resumed after a real gap → briefly, visibly acknowledged.
- Different or ambiguous → a new logical conversation starts automatically, or Hubi asks — never a silent context switch.

**Google Chat's own native threads are explicitly not the primary model.** A Chat thread is a UI affordance of the channel; the logical conversation boundary is owned by Hubi's Conversation Resolution, independent of how Chat happens to group messages visually. Conversation management belongs to Hubi.

**Start Fresh** is the one explicit escape hatch — for when the user wants to deliberately discard the offered continuity, not for routine conversation management. Selecting it closes the current logical conversation (preserving its history), opens a new one, and leaves the old one reachable from the Web App.

**"Open in Hubi" is deferred to a future version and is explicitly not part of the V1 interaction model.** It remains a reasonable future direction — escalating a long or project-oriented Chat conversation into the Web App's fuller surface — but nothing in V1's design should assume or depend on it.

---

## Backoffice

Conversation history is private to the user by default. See Conversation Governance, above, for the decided V1 scope (one administrator, purpose-limited, never auto-promoted to organizational knowledge).

---

## Interaction With the Runtime, Business Context, Knowledge Retrieval, and the Knowledge Center

Conversation Resolution is a new stage, upstream of everything `Product_Architecture.md` Section 5 already describes:

```
                    Conversation Resolution  (decides which conversation, if any, applies)
                              │
                              ▼
              Resolved Conversation (active / resumed / new)
                              │
                              ▼
User Context ─────────────────┐
Business/Task Context ────────┤
Conversation Context ─────────┼──►  Applicability Layer  ──►  Eligible Knowledge  ──►  Applicable Knowledge  ──►  Grounded Reasoning  ──►  Answer
  (seeded, never dictated, by      (policy engine)
   resumed work history, if any)
Knowledge Usage Policy ────────┤
Knowledge Lifecycle ───────────┘
```

Three things must hold, without exception, for this integration to be safe:

- **Resumed work history becomes Conversation Context, and nothing more.** Available for the user to reference and for Hubi to acknowledge — never treated as a business fact, never handed to Reasoning as if it were retrieved knowledge.
- **Knowledge Retrieval always runs fresh.** A resumed conversation never reuses a previous retrieval result or a previous answer as current truth.
- **Business Context still wins.** Resolution can offer a starting point; it cannot override what the user actually states now.

The Runtime's existing Conversation Orchestrator and Context Builder (`Architecture.md`) gain one new upstream input — the Resolved Conversation — and otherwise operate exactly as already designed.

---

## Identity — Decided and Open

**Decided:** Google Chat will use the authenticated Google Workspace identity. Conversation Continuity in Chat therefore assumes a persistent, authenticated user identity from day one — the foundational dependency flagged in the previous revision of this document is resolved for that channel.

**Still open:** the Web App's authentication mechanism. Conversation Continuity in the Web App cannot function without *some* durable identity — today's anonymous, per-browser-session model isn't compatible with it — but which mechanism (a lightweight login, the same Workspace identity, or something else) is not yet decided. This is the one decision that genuinely blocks building Conversation Continuity into the Web App.

---

## Context Inference — Decided

Business context is normally established once, explicitly, by the user. After that, Hubi may infer context for continuation from the ongoing conversation or from uploaded documents, consistent with "explicit context always outranks inferred context" above. Whenever confidence in an inferred value becomes insufficient, Hubi confirms with the user explicitly rather than assuming. No external system integration (e.g. pulling account data from a CRM) is assumed or required for V1 — it's a reasonable future enhancement, not a dependency.

---

## Remaining Open Product Decisions

Only one blocks implementation:

1. **Web App authentication mechanism** — required before Conversation Continuity can exist in the Web App at all.

The rest can safely wait until after the initial Web App prototype:

2. Whether to expand backoffice access beyond the single initial administrator, and what audit trail that would require.
3. Whether to integrate an external system of record (e.g. a CRM) as a source for Context Scope values, rather than relying on explicit statement and inference alone.
4. Any future proactive-suggestion behavior for "Open in Hubi," once that capability is actually built.
5. Retention policy evolution, if and when indefinite retention needs revisiting.

---

## Final Review

**Is Conversation Continuity Architecture conceptually stable?** Yes. Every open question from the prior revision has been either decided (identity for Chat, context inference behavior, backoffice scope, retention, the role of time) or explicitly and deliberately deferred (Open in Hubi, external system integration, backoffice expansion) rather than left ambiguous. The only decision that still blocks implementation is Web App authentication — everything else in this document can be built against as-is.

**Which decisions still block implementation?** Just the one: Web App authentication mechanism. Google Chat has no blocking identity gap left.

**Which decisions can safely be postponed past the initial Web App prototype?** Backoffice expansion beyond one administrator, CRM-style external context integration, "Open in Hubi" entirely, and any future revisiting of indefinite retention.

**Should `Product_Architecture.md` now reference Conversation Continuity as a core capability?** Yes. It belongs in that document as a named, first-class concept — not filed under "Future Evolution," since it's no longer speculative — while every implementation-independent detail (Context Scopes, Conversation Resolution's decision flow, the transparency principle, Conversation Governance) stays exclusively in this document, referenced rather than duplicated. I'll make that cross-reference edit now, since it's a small, consistent addition rather than a new design decision.
