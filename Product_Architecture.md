# Hubi — Product Architecture

**Version 1.** This is a conceptual document, not an engineering specification. It explains how Hubi is expected to work from a product and knowledge-management perspective, and serves as the long-term reference for future engineering decisions. It contains no implementation details, algorithms, or code — those live in `Architecture.md` (target technical architecture) and `Prototype_Plan.md` (current implementation state).

---

## 1. Product Vision

Hubi exists to make organizational Revenue knowledge immediately accessible, understandable, and actionable — so that Revenue employees can focus on customers instead of hunting for documentation, playbooks, or the right person to ask.

**Hubi is not the owner of knowledge. It is a consumer of the Knowledge Center Content Registry — but the relationship is not one-directional.**

The Knowledge Center Content Registry is the canonical source of truth for knowledge governance: what content exists, who is accountable for it, who it is intended for, where it applies, and whether it may be used at all. Hubi's role is narrower and more disciplined than "answering questions from documents" — Hubi retrieves, interprets, and presents knowledge *according to the governance rules the Registry has already established, and according to the actual business context of the person asking*. Hubi does not decide what counts as trustworthy, eligible, or applicable knowledge. The Registry decides that. Hubi respects it.

At the same time, Hubi is positioned to observe something the Registry cannot see on its own: how knowledge is actually used, where it falls short, and what's missing. This creates a loop, not a pipe:

```
Knowledge Center Content Registry
        │
        ▼  governs
       Hubi
        │
        ▼  generates
Knowledge Intelligence
(Knowledge Demand · usage signals · content gaps · governance blind spots)
        │
        ▼  informs
Knowledge Center Content Registry
```

Governance flows down: the Registry tells Hubi what may be used, by whom, and where it applies. Intelligence flows up: Hubi surfaces recurring Knowledge Demand, frequently-relied-upon assets, questions it couldn't answer, documentation that should exist but doesn't, and governance decisions that real usage suggests deserve a second look. This does not change *who* governs knowledge — the Registry still does. It means Hubi is also a source of evidence the Knowledge Center can use to govern better over time.

This bidirectional relationship — governed by the Registry, generating intelligence back to it — is the foundation for everything else in this document.

---

## 2. Product Principles

These principles were established through direct investigation of real product behavior, not assumed in advance. They should outlive any specific implementation.

- **Language is not applicability.** The language a question is asked in says nothing about which region's process, policy, or content applies to it. Treating language as a proxy for region or business applicability produces answers that look grounded while being operationally wrong.
- **User context is not business context.** Who is asking is a different fact from what they are asking about. A user's own region, role, or habitual segment is a starting point — never a substitute for the region, client, or segment the question is actually about.
- **Business context takes precedence over default user context.** Whenever the two conflict, what the question is actually about wins over who happens to be asking.
- **AI must never bypass knowledge governance.** Eligibility, ownership, and lifecycle decisions belong to the Knowledge Center Content Registry. Hubi's reasoning layer operates only within the boundaries governance has already set — it does not have the authority to decide an asset is usable when governance says otherwise.
- **Hubi retrieves broadly but answers narrowly.** Casting a wide net while finding candidate knowledge — across languages, across sources — is appropriate and encouraged. What gets presented as the answer must be narrowly scoped to what is actually eligible, applicable, and relevant.
- **Clarification is preferable to confident but incorrect answers.** An honest question back to the user is always a better outcome than a fluent, well-cited answer built on the wrong regional process, the wrong segment, or the wrong assumption. A confident wrong answer is more dangerous than an honest non-answer, because it looks trustworthy while being wrong.
- **Governance decisions should be deterministic whenever possible.** Whether an asset may be used, and whether it applies to a given region or audience, should be decided by explicit metadata rules wherever that metadata exists — not left to a model's inference or self-report. *This is the defining mandate of the Applicability Layer (Section 5).*
- **AI reasoning should only occur after governance and applicability constraints are satisfied.** Reasoning is the last step, not the first. It operates on a knowledge set that has already been filtered for eligibility and applicability — it is never the layer responsible for deciding those things. *Also a defining mandate of the Applicability Layer.*

**Additional principles adopted from the same investigations:**

- **Global is a claim, not a default.** Content should be treated as universally applicable only when it has been explicitly and deliberately marked so. Absence of a stated region is not evidence that something applies everywhere — it is a gap that should prompt caution or clarification, not an assumption of universal applicability.
- **The Registry governs applicability, not factual accuracy.** The Registry is canonical for whether and how an asset may be used. Whether the asset's actual content is correct remains the accountability of its business owner/SME — Hubi consuming governance metadata is not a substitute for that ownership.
- **Traceability is how trust is earned, not asserted.** Every answer should be traceable to the sources that grounded it and to the governance/applicability decisions that permitted their use. Trust comes from what can be verified, not from how confident an answer sounds.
- **Cost and latency are product constraints, not only engineering concerns.** Hubi shares AI usage with other initiatives. Capabilities with a real per-use cost (like cross-language expansion) should be invoked only when genuinely needed, not applied by default to every interaction.
- **Every interaction is a knowledge signal, not just a transaction.** What Hubi is asked, and how well it could answer, is itself information about the health of the knowledge base — where it's strong, where it's thin, and where real Revenue work is asking for something that doesn't exist yet. This is the principle the Knowledge Intelligence loop (Section 1) is built on.

---

## 3. Core Concepts

A shared vocabulary for everything that follows.

- **Knowledge Center Content Registry** — the canonical governance record of Revenue knowledge assets: what exists, who owns it, who it's for, where it applies, and whether it may be used by AI. The authority Hubi defers to, not a system Hubi manages.
- **Knowledge Asset** — one independently governable unit of knowledge (a course, playbook, deck, guide, template). The same asset may be hosted on different platforms, but it has one governance identity in the Registry.
- **Metadata** — structured facts *about* a Knowledge Asset. Metadata describes governance and applicability; it is not the content itself.
- **Knowledge Usage Policy** — the complete set of governance rules the Registry assigns to a Knowledge Asset, describing whether, how, and by whom it may be used. AI Eligibility is one outcome of this policy, not the whole of it — Restrictions, Access Level, Client-shareability, and flagged known issues are different expressions of the same underlying policy, not independent rules to reconcile one by one.
- **Knowledge Lifecycle** — the stage a Knowledge Asset is currently in, from creation through active use to eventual retirement (Draft, Active, Under Review, Deprecated, Archived, and the pace at which it should be revisited). Content Status is the field that expresses an asset's current lifecycle stage. Hubi respects the lifecycle the Knowledge Center manages; it does not manage the lifecycle itself.
- **Chunk** — a retrievable fragment of a Knowledge Asset's actual content, sized for relevance and citation, always traceable back to its parent asset and inheriting that asset's Knowledge Usage Policy and Lifecycle stage.
- **User Context** — who is interacting with Hubi: their organizational region, role or team, habitual segment, and language preference. A default and a personalization signal, not a constraint on what they may ask about.
- **Business Context (Task Context)** — what the current question is actually about: the client, subsidiary, region, segment, product, or process under discussion. May differ entirely from the user's own context.
- **Conversation Context** — what has been explicitly stated or clarified during the current exchange. The most immediate and authoritative context available, and the one that supersedes defaults.
- **Conversation Continuity** — the capability that lets a user resume prior work, in the same channel or a different one, without ever confusing which business situation it belonged to. Not memory, and not a source of business facts — a governed decision about whether prior work is safe to reattach to the current interaction, made by Conversation Resolution before Conversation Context is ever populated from it. Fully specified in `Conversation_Continuity_Architecture.md`; a core Hubi capability, not a speculative future one.
- **Applicability** — whether a given Knowledge Asset is eligible, preferred, or incompatible for a specific question, given its Knowledge Usage Policy, its Lifecycle stage, and the current business context.
- **Applicability Layer** — Hubi's policy engine. Its responsibility is not retrieval and not reasoning — it is deciding whether reasoning is allowed to happen at all, and under what constraints, before either proceeds.
- **Knowledge Demand** — a recurring or emerging need for knowledge that Hubi cannot yet fully satisfy. Broader than "a training gap": may indicate missing documentation, a confusing process, a missing tool or template, or conflicting information across sources.
- **Knowledge Intelligence** — the operational signals Hubi generates through real use: recurring Knowledge Demand, usage patterns, content gaps, and governance blind spots. The mechanism by which the loop described in Section 1 actually functions.
- **Retrieval** — the mechanism Hubi currently uses to find eligible, topically relevant knowledge candidates. A replaceable implementation detail (lexical today, potentially semantic later) behind a stable conceptual step: turning eligible knowledge into candidates for applicability.
- **Reasoning** — the mechanism that composes a grounded answer from applicable knowledge. Also replaceable; what must remain stable is that it only ever operates after applicability has been established, never before.
- **Governance** — the rules, ownership structures, usage policy, and lifecycle decisions that determine whether and how something may be used. Two distinct domains exist under this one concept: **Knowledge Governance** (Knowledge Assets, owned by the Knowledge Center) and **Conversation Governance** (conversations, owned by Hubi itself — see `Conversation_Continuity_Architecture.md`). Same principle, different authority, never to be confused with each other.

---

## 4. Knowledge Governance

The Knowledge Center Content Registry is the canonical governance source. Hubi consumes governance decisions; it does not create, override, or infer them.

Governance, conceptually, breaks into three distinct questions, each answered by a different kind of field:

**May this asset be used, and how? (Knowledge Usage Policy)**
- **AI Eligibility** — whether an asset may be used by Hubi at all. A governance decision made by people accountable for the content, not a quality signal Hubi is free to estimate on its own. This is the most binding expression of Usage Policy: when it says no, nothing downstream may override that.
- **Restrictions** (access level, client-shareability, and any conditional eligibility) — the conditions under which an otherwise-eligible asset may be used: by whom, and in what setting. An asset can be eligible overall and still restricted in how it's used.
- **Notes / known issues** — caveats a governance owner has already identified (incomplete content, conflicting information, sensitivity). Signals for Hubi to treat the asset with additional caution, not information to discard.

**Where is this asset in its life, and how much should that be trusted right now? (Knowledge Lifecycle)**
- **Content Status** — whether an asset is currently active and trustworthy, or retired, deprecated, or archived and should not be surfaced as current guidance.
- **Priority** — how important or time-sensitive an asset is from a content-governance review standpoint. This is a governance concept about *the content's* review cadence, distinct from any business concept of client segment or tier — the two must never be conflated in language or in practice.
- **Review information** — whether an asset's accuracy has been recently reconfirmed. Informs how much confidence an answer built from it deserves.

**Where and for whom does this asset's content actually apply? (Applicability descriptors)**
- **Region** — where an asset's content is operationally applicable. Independent of the language the asset happens to be written in.
- **Audience** — who the asset is intended for.

These are governed, canonical facts from the Registry like the others, but they answer a different question than policy or lifecycle do — they describe *fit*, which is what the Applicability Layer (Section 5) evaluates against business context, rather than describing *permission* or *life stage*.

**Owner** sits outside all three groupings: who is accountable for the asset's accuracy and currency. Hubi answering a question grounded in an asset never transfers or substitutes for that accountability.

**Metadata synchronization, conceptually:** Hubi maintains its own working copy of governance metadata, refreshed from the Registry on a periodic or on-demand basis rather than queried live for every question. This keeps Hubi fast and resilient to the Registry being temporarily unreachable, while ensuring the working copy is always a known, traceable snapshot — every answer can be tied back to the governance state that was in effect when it was given, so freshness is always visible, never assumed.

**Hubi consumes governance; it does not create it.** When the Registry doesn't resolve an ambiguity, the correct behavior is for Hubi to say so — never to invent a governance rule of its own to fill the gap.

---

## 5. Context and Applicability

```
User Context ──────────────┐
Business/Task Context ─────┤
Conversation Context ───────┼──►  Applicability Layer  ──►  Eligible Knowledge  ──►  Applicable Knowledge  ──►  Grounded Reasoning  ──►  Answer
Knowledge Usage Policy ─────┤        (policy engine)
Knowledge Lifecycle ───────┘
```

**The Applicability Layer is Hubi's policy engine.** Its responsibility is not retrieval and not reasoning — it is deciding whether reasoning is allowed to happen at all, and under what constraints. Concretely, it is where questions like these get answered, deterministically wherever governance metadata makes that possible:

- Is this knowledge eligible under its Usage Policy?
- Is it applicable to the current business context?
- Should a particular source be excluded?
- Can Global content be used here?
- Must a restriction be enforced?
- Is the available business context sufficient to answer, or is clarification required?

Only once these questions are resolved does knowledge move from merely *found* to genuinely *usable*. Retrieval and Reasoning both operate downstream of this layer, never ahead of it.

**Responsibility of each component:**
- **User Context** supplies defaults and a personalization signal — who is likely asking, and how they'd generally prefer to be addressed. It never determines, by itself, what a specific question is actually about.
- **Business/Task Context** defines what the current question concerns — a specific client, region, segment, or process. It takes precedence over User Context whenever the two would otherwise conflict.
- **Conversation Context** is what has been explicitly said or clarified in the exchange so far. It is the most immediate source of truth, capable of updating or superseding both defaults and previously assumed business context.
- **Knowledge Usage Policy and Knowledge Lifecycle** supply the governance facts the Applicability Layer enforces — what may be used, and how current it is.
- **Eligible Knowledge** is knowledge whose Usage Policy and Lifecycle stage permit it to be considered at all.
- **Applicable Knowledge** is eligible knowledge that also fits the current business context.
- **Grounded Reasoning** composes an answer only from applicable knowledge, and asks for clarification whenever the Applicability Layer determines the available knowledge or context is insufficient — it does not have the authority to override an applicability decision by generalizing past it.
- **Answer** is presented with visible traceability to its sources and to the applicability basis for using them.

This three-state progression — **eligible → applicable → grounded** — is the conceptually stable backbone of the architecture. The specific mechanisms that move knowledge between these states (lexical retrieval today, semantic retrieval potentially later; today's reasoning engine or a future one) may change without changing this model.

**Context precedence rules:**
1. Conversation Context, once explicitly stated, always takes precedence.
2. Business/Task Context overrides default User Context whenever they conflict.
3. User Context is usable only as a fallback default, a personalization signal, or a clarification shortcut — never as a silent override of stated business context.
4. When context required for a correct answer is missing and would materially change it, Hubi asks rather than assumes.

---

## 6. Knowledge Retrieval Philosophy

- **Multilingual retrieval:** Hubi should find relevant knowledge regardless of what language a question is asked in. Organizational knowledge exists in multiple languages; the language of a question is a fact about how it was typed, not a statement about which knowledge applies.
- **Conditional query expansion:** broadening a search across languages is a capability Hubi uses when needed, not a default applied to every question. Most questions can be answered without it, and invoking it has a real cost.
- **Applicability-aware retrieval:** retrieval only ever searches within Eligible Knowledge, and its results still pass through the Applicability Layer before being treated as Applicable. "Relevant" and "applicable" are different questions, and both must be satisfied — relevance alone is not sufficient grounds to use a source.
- **Retrieval versus reasoning responsibilities:** retrieval's job is to surface candidates; it does not decide what the answer is. Reasoning composes an answer only from candidates already established as applicable — it does not get to revisit or override an applicability decision made upstream.
- **Global versus regional content:** content that is genuinely, deliberately marked as globally applicable should never be withheld just because the current business context names a specific region. The reverse also holds: region-specific content should never be presented as if it were global just because nothing more specific was found.
- **Clarification rules:** when the only relevant knowledge available is specific to a region, segment, or audience that doesn't match — or isn't yet known from — the current business context, Hubi asks before answering, rather than presenting its best available match as though it were confirmed to apply.

---

## 7. Logging Philosophy

Hubi logs every interaction, but diagnostics are not the primary purpose. **Interaction history is evidence of the health of the knowledge ecosystem itself** — it is the primary mechanism by which Hubi's Knowledge Intelligence (Section 1) is actually produced. Read over time, it should help answer questions such as:

- Which governance rules are frequently blocking otherwise-useful content?
- Which content is repeatedly missing or insufficient?
- Which areas of the business generate the highest Knowledge Demand?
- Which assets are heavily relied upon, and which are never used at all?
- Which governance decisions — an eligibility call, a region tag, a restriction — does real usage suggest deserve a second look?

This record is meant to support:
- **Product improvement** — understanding what's genuinely useful and what isn't.
- **Knowledge governance** — surfacing which assets are actually relied upon, and which are stale, missing, or contested.
- **Content lifecycle** — generating real signals the Knowledge Center can act on, rather than lifecycle decisions made blind.
- **Knowledge Demand analysis** — recognizing recurring needs Hubi cannot yet fully satisfy, beyond framing every gap as a training problem.
- **Future personalization** — once a legitimate, earned basis for it exists.
- **Analytics** — once there is enough real signal to justify it. Analytics is a possible future use of the record, not the reason the record exists.

**Distinctions that must be preserved, not collapsed into one another:**
- **Interaction logs** — the base record of what was asked, what was answered, and under what context.
- **Retrieval evidence** — what knowledge was considered, and why it was or wasn't judged applicable.
- **Applicability decisions** — the governance-driven choices about eligibility and the need for clarification, kept visible and auditable rather than folded silently into the answer text.
- **Feedback** — the user's own subjective judgment of whether an answer helped. A different kind of signal from the system's own account of what happened.
- **Manual review** — a person's after-the-fact classification of an interaction, including its Knowledge Demand type. Always additive, never a rewrite of the original record.

These stay separate because each answers a different question. Collapsing them would make every one of them harder to trust individually — and would weaken exactly the evidence the Knowledge Intelligence loop depends on.

---

## 8. Future Evolution

The architecture described here is deliberately built to extend, not to be replaced, as Hubi matures.

- **IAM integration:** today's session-level User Context is a placeholder for what an authoritative identity system will eventually supply automatically — organizational region, role, and access permissions — without requiring the rest of the context/applicability model to be redesigned.
- **Personalization:** once genuine usage history accumulates, Hubi can begin tailoring guidance to a user's habitual context and past interactions, built on the same context and logging foundation already in place, not a separate system bolted on later.
- **Recommendations:** proactively surfacing relevant knowledge, related materials, or a logical next step becomes viable once retrieval, applicability, and logging are mature enough to support it reliably.
- **Embeddings and advanced retrieval:** if lexical retrieval's limits are ever reached in ways conditional, governance-aware expansion can't address, semantic retrieval is a natural next layer — additive to today's architecture. Governance and applicability remain metadata-driven regardless of which retrieval mechanism is underneath them.
- **Analytics:** structured analysis and dashboards over Hubi's logs become worthwhile once there is a meaningful volume of real interactions. The logging foundation is deliberately built now so that future analysis never requires reconstructing history that wasn't captured.
- **Governance automation:** today's periodic, deliberate metadata synchronization is a starting point. More automated or near-real-time synchronization with the Knowledge Center Content Registry is a natural evolution, not a foundational change to how governance and Hubi relate to each other.

**The Knowledge Center Content Registry is also expected to evolve, independently of Hubi:** richer governance metadata, stronger lifecycle management, automated governance workflows, improved metadata quality, and broader adoption across AI assistants beyond Hubi. Because Hubi already treats the Registry as an external authority it consumes rather than a system it embeds, it is positioned to benefit from all of these improvements automatically, without architectural redesign. This reinforces a boundary worth stating plainly: **Hubi is one consumer of an evolving knowledge platform, not the center of it.**

Across all of this, one boundary should remain constant: **what Hubi decides (retrieval, reasoning, presentation) and what governance decides (eligibility, applicability, ownership) do not change roles as capabilities mature.** That boundary is the architectural constant everything else is designed around.

---

## Remaining Product Decisions Requiring Explicit Approval

1. Exact required handling for governance-restricted ("eligible with conditions") content — usable with a caveat, or does it require clarification too?
2. Whether Content Status filtering (excluding retired/deprecated/archived assets) should be addressed in the same effort as AI Eligibility filtering, given both are the same class of governance gate.
3. Whether to invest in more robust, structured access to the Content Registry now, versus a simpler first pass, given real parsing fragility encountered during direct inspection.
4. Sequencing of access-level/permission enforcement — meaningful only once real user identity exists; necessarily partial before then.
5. Ownership of the region-canonicalization mapping between the Registry's vocabulary and any locally-held metadata — an engineering-maintained mapping, or a governance-owned field in the Registry itself?
6. Whether capturing a user's habitual segment is worth doing yet, given no content-side segment/tier governance metadata exists today for it to be checked against.
7. Retention policy for interaction logs once a given testing phase concludes — kept for longitudinal analysis, or archived/deleted on a schedule?

---

## Architectural Review

**What changed in this revision:** the Vision and Logging Philosophy now explicitly describe Hubi as bidirectional — governed by the Registry, and generating Knowledge Intelligence back to it. Knowledge Lifecycle and Knowledge Usage Policy are introduced as named concepts, replacing the earlier flat list of governance fields with three distinct questions (permission, life stage, fit). The Applicability Layer is elevated from a flow component to Hubi's policy engine, with its gating responsibility made explicit. The Context/Applicability flow now ends in conceptual states — Eligible Knowledge, Applicable Knowledge, Grounded Reasoning — rather than naming Retrieval and Reasoning as the primary milestones; those remain defined concepts, but as replaceable mechanisms rather than architectural stages. Logging Philosophy and Future Evolution both now name the Registry's own evolution and the ecosystem-health role of interaction history explicitly.

**One thing I resolved rather than applied literally:** introducing both "Knowledge Usage Policy" and "the Applicability Layer as policy engine" created a naming collision — two different concepts both called "policy." I kept both, because they're genuinely different things, but made the distinction explicit: Usage Policy is *authored* by governance (external to Hubi); the Applicability Layer *enforces* it (internal to Hubi). If "policy engine" still reads as too close to "Usage Policy" in practice, the cleaner fix would be to rename the Applicability Layer's description to "decision engine" instead — I'd defer that specific word choice to you, since it's a small naming call, not a conceptual one.

**One place I deliberately didn't change:** Section 6's title stays "Knowledge Retrieval Philosophy," even though your instruction was to reduce implementation-oriented language where possible. That title was part of your own original eight-section outline, and the section's content is genuinely about product-level retrieval behavior (multilingual, conditional, applicability-aware), not implementation. I applied the "reduce implementation emphasis" instruction to the flow diagram and the Retrieval/Reasoning concept definitions instead, where it was your own explicit example.

**A simplification made along the way:** Region and Audience don't actually belong under "Knowledge Usage Policy" (permission) or "Knowledge Lifecycle" (life stage) — they answer a third, different question ("where and for whom does this apply"), which is exactly what the Applicability Layer evaluates against business context. Forcing them into Usage Policy would have been the kind of unclear-terminology problem you asked me to watch for, so I gave them their own grouping instead ("Applicability descriptors") rather than overloading Usage Policy to cover everything governance-related.

**Principles that are now architectural constraints, not just guidance:** "Governance decisions should be deterministic whenever possible" and "AI reasoning should only occur after governance and applicability constraints are satisfied" aren't general advice anymore — they are literally the specification for what the Applicability Layer exists to do. I've cross-referenced this in Section 2 rather than leaving it implicit.

**Is this stable enough to become the standing reference?** Yes. The document is now internally consistent — every section's vocabulary traces back to Section 3's definitions, the governance field taxonomy no longer has a field that fits two categories at once, and the bidirectional loop introduced in Section 1 is carried through Logging Philosophy and Future Evolution rather than mentioned once and dropped. The one open item is the "policy" naming question above, which is small enough not to block treating this as the standing reference — it can be resolved whenever it's convenient, without touching the underlying concept. I'd recommend proceeding with this as Version 1 of Hubi's Product Architecture.
