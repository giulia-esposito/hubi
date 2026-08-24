# Response Mode: Grounding Rigor vs. Reasoning Latitude

> **Superseded.** Kept verbatim for the historical record (this project's convention — see `Prototype_Plan.md`'s own preserved-appendix approach), not deleted. Product challenged the "Response Mode" framing itself as too shallow — the real gap is upstream of response construction, not at it. See `docs/task-planning-architecture.md` for the revised analysis, including an explicit account of what changed here and why. Section 1–4 below (the investigation evidence: the real transcript, the system prompt, the code-path confirmation) remain accurate and are reused, not redone, in that document.

**Status: architectural investigation + design proposal, not yet implemented. No code, no prompts, and no other document were changed to produce this.** Written in response to a direct product observation (Hubi vs. NotebookLM on the same conversation) that surfaced a genuine, previously-undocumented gap in the conceptual architecture — not a bug, not a contradiction of anything already decided. Nothing in this document should be implemented until Product reviews it.

---

## 1. Investigation Report

### 1.1 The question this investigation answers

Does Hubi today distinguish *what kind of help* a request needs, or does every request — factual lookup, procedural lookup, summarization, writing assistance, coaching, brainstorming, business preparation — get exactly the same reasoning policy?

**Answer: confirmed, every request gets exactly the same policy. There is no request classification anywhere in the running system.**

### 1.2 Direct evidence there is no classification

- **`app/api/chat/route.ts`** (the Web UI's entire backend) has exactly one branch: `results.length === 0` (a retrieval-count check, not a request-type check) → deterministic refusal. Every other request — regardless of what it's asking for — follows the identical sequence: `search()` → `buildPrompt()` → the same `HUBI_SYSTEM_PROMPT` → `askClaudeCode()`. There is no second code path.
- **`scripts/ask.ts`** (the terminal tool) is architecturally identical — same modules, same single sequence.
- A repository-wide search for classification logic (`classif`, `requestType`, `intent`, `category`) returns exactly two hits, both **comments explaining that no classifier exists**:
  - `lib/runtime/sessionState.ts:30`: *"...without building a separate intent/context classifier."*
  - `lib/runtime/turnKind.ts:19`: *"This is a model self-report, not independent classification..."*
- This is not an oversight — it's a recorded decision. `Prototype_Plan.md` Section 6: *"No separate Context Builder or Request Classification component was built... a classifier will only be introduced if testing proves this insufficient — it has not, so far."* **This investigation is the first concrete evidence that it may now be insufficient.**

### 1.3 The current reasoning policy, in full

`lib/runtime/promptBuilder.ts` — `HUBI_SYSTEM_PROMPT`, sent identically on every single turn, verbatim:

> "You are Hubi, Wellhub Revenue's AI Copilot. Answer only using the 'Retrieved Knowledge' provided in the user message below -- you have no other tools, files, or knowledge sources available to you.
>
> Rules:
> - You do not know who is asking. Never address the user by name or assume an identity, even if you think you can infer one.
> - **Ground every substantive claim in the retrieved knowledge provided below. Do not rely on outside knowledge about Wellhub, competitors, or sales processes beyond what's given to you here.**
> - **If the retrieved knowledge does not clearly answer the question, say so plainly instead of guessing or inventing an answer.**
> - If answering well depends on business context you don't have (e.g. region, segment, client status) and the retrieved knowledge covers more than one case, ask a clarifying question instead of assuming which one applies. Ask only one focused question at a time.
> - If a 'Conversation so far' section is present, use it to understand what's already been asked and answered -- do not re-ask for context the user already gave you earlier in this conversation.
> - Keep the answer focused and conversational, as if speaking to a Revenue teammate.
> - End your response with exactly one trailing tag..."

**The two bolded rules are the entire mechanism driving the behavior you observed.** Read literally, they instruct the model to treat *every* request as a question with a factual answer that either exists verbatim in the retrieved text or doesn't — there is no clause anywhere that distinguishes "does the documentation say X" from "help me produce Y using what the documentation establishes as true." A request to draft a pitch is processed by the same rule as a request to look up a pricing threshold.

### 1.4 The real conversation, as it actually happened

You ran this conversation for real, and it's already captured in `logs/interactions.jsonl` — I pulled the actual records rather than reconstructing them:

**Turn 1 — "How can I present Wellhub to a prospect? Write a 1-min elevator pitch"**
Retrieved: RKO 2026 Elevator Pitch scorecard + Simplified Pricing Narrative. Response opened with *"While the retrieved knowledge doesn't contain a word-for-word script, it does lay out exactly which pillars a strong Wellhub pitch must hit"* — then **did** construct a full pitch. `turnKind: grounded-answer`.

**Turn 2 — "A company from financial industry, Enterprise."**
Response: *"Honestly, the retrieved knowledge doesn't contain financial-industry-specific or ENT-specific pitch content, so **I can't give you a version that's precisely tailored** to a financial-sector Enterprise prospect."* It then pivoted to generic advice ("get curious about *this* prospect... personalize it live") rather than actually tailoring anything. `turnKind: no-grounded-answer`.

**Turn 3 — "Help me tailor it... mostly desk workers, 25-40, increasing burnout"**
Response opened: *"I want to be upfront about what I can and can't ground here... I can't hand you validated claims like 'Wellhub reduces burnout by X%'"* — a **correct** refusal (that specific statistic doesn't exist and must not be invented) — but wrapped around it with enough hedging that it reads as a refusal of the whole request. It then **did** construct a tailored opening anyway. `turnKind: grounded-answer`.

**What this shows, precisely:** Hubi is not incapable of constructing tailored output — it did so in turns 1 and 3. The actual problem is twofold, and both trace directly to the two bolded rules in 1.3:
1. **Inconsistent line-drawing.** Turn 2 declined to tailor by industry (a request that needs no invented facts, only reasoning about how to frame existing, grounded facts for a different audience) using the same refusal language it correctly used elsewhere for a request that genuinely would have required an invented statistic. The prompt gives the model no vocabulary to tell these two situations apart, so it doesn't reliably tell them apart either.
2. **Defensive framing regardless of outcome.** Even when Hubi *does* help, every response opens by explaining what it can't do before what it can. This is a direct, faithful reading of "if the retrieved knowledge does not clearly answer the question, say so plainly" — applied to a request that was never really "a question with a factual answer" in the first place.

### 1.5 NotebookLM comparison — what can and can't be claimed here

**Important caveat, stated plainly: I have no access to NotebookLM's system prompt, source code, or internal design documents.** Everything below is inference from its publicly observable product behavior and stated purpose, not a verified technical fact, and should be weighted accordingly — it is supporting context for the architectural reasoning, not evidence with the same standing as Sections 1.2–1.4.

NotebookLM is explicitly positioned as a tool for *working with* a set of sources — drafting, briefing, brainstorming from them — not only for answering factual questions about them. Its observable behavior (treating uploaded sources as material a user directs it to use, rather than as a closed set of sentences it may only quote or refuse) is consistent with a design that separates "is this claim grounded" from "am I allowed to construct a new artifact from grounded claims." Hubi's current system prompt collapses those two questions into one. That collapse — not a difference in underlying model capability — is the most defensible technical explanation for the behavioral gap you observed. (Both tools are very likely built on comparably capable underlying models; the difference in observed behavior is a policy/prompt difference, not a capability difference.)

### 1.6 Does Architecture.md already anticipate this?

Partially — and this is the most important structural finding. `Architecture.md` Section 3 ("Request Classification") already documents four request types: **Direct Question, Business Scenario, Decision Support, Process Guidance.** But re-reading each type's "expected behavior" list against what you're asking for:

| Existing type | Its documented expected behavior | Does it authorize constructing a work product (pitch, email, discovery questions)? |
|---|---|---|
| Direct Question | retrieve, answer directly, cite | No |
| Business Scenario | identify objective, ask follow-ups, "provide grounded guidance, materials, and next steps" | Ambiguous — "guidance" could be read either way, but no example matches "write/draft/tailor" |
| Decision Support | present documented options, explain trade-offs, "leave the final decision to the user" | No — explicitly leaves *construction* of the decision to the user, which is a different thing from constructing a *work product* |
| Process Guidance | present steps, cite, "avoid inventing missing steps" | No |

**None of the four documented request types explicitly authorizes what you're asking for.** This is not a contradiction of anything decided — Request Classification was never built, so nothing in code contradicts it — but it is a genuine gap in the *conceptual* architecture itself, surfaced for the first time by this investigation, not something I'm inferring should exist. Flagging it rather than deciding it, per how this project has agreed to handle exactly this situation.

Separately, `Product_Architecture.md`'s own definition of Reasoning is: *"the mechanism that **composes** a grounded answer from applicable knowledge."* "Composes" is a broader word than the system prompt currently permits — the conceptual architecture may already have more room for this than the implementation uses. That's a second reason to treat this as a **prompt/policy gap**, not necessarily a **conceptual-document gap** — though Section 3 below argues one specific conceptual addition is still warranted.

---

## 2. Architectural Assessment

**Root cause: the system prompt encodes one implicit assumption that was never made explicit or examined — that "grounded" means every sentence in the output must be traceable to a specific retrieved sentence.** That assumption is exactly right for a factual lookup. It is the wrong assumption for a request to draft, tailor, or coach, where the correct standard is: *every factual claim embedded in the output must be traceable to grounded knowledge, but the output's structure, framing, and connective reasoning may be constructed.*

This is not a case of Hubi being "broken" — the prompt is doing precisely what it says. It's a case of one policy being applied uniformly to what are, on inspection, at least two structurally different jobs.

**Your proposed three-category framing holds up well against the evidence.** Mapping it to what was actually observed:

- **Category A (Facts)** — none of the three turns in your test conversation were actually this category, but this is exactly the category Findings #001/#002 are about: pricing, eligibility, region-specific process. Strict grounding is correct and must not weaken here — this is a hard boundary, not a spectrum.
- **Category B (Knowledge synthesis)** — not tested directly in this conversation, but describable from what Turn 1 actually did well: it drew from two documents (the pitch scorecard + the pricing narrative) into one coherent answer.
- **Category C (Business assistance)** — this is what all three turns of the test conversation actually were, and it's the one the current prompt has no vocabulary for. Turn 2's failure and the hedging in Turns 1 and 3 are both explained by Category C requests being run through Category A's policy.

**One necessary refinement, not a rejection of the framework:** your examples list "write an email," "tailor a pitch," "discovery questions" alongside "prepare objection handling" and "prepare negotiation." The first group needs *only* structural/framing latitude over already-grounded facts. The second group ("objection handling," "negotiation") can shade into **advice about what the user should do or say strategically** — closer to *Decision Support* territory, where `Product_Architecture.md`'s existing principle ("AI must assist, humans decide... Hubi should never decide on behalf of someone") is directly load-bearing. Category C needs an explicit internal boundary: *construct the artifact, but do not decide the user's negotiating position for them* — otherwise Category C risks quietly reintroducing the exact thing Decision Support was designed to prevent. This is a refinement to work through with you, not a reason to abandon the category.

**A naming note, in the spirit of how this project already treats naming carefully (see `Product_Architecture.md`'s own "Architectural Review" section on the "policy" collision):** your Category A/B/C axis answers *"how much construction latitude is Reasoning allowed"* — a different question from Architecture.md's existing Request Classification, which answers *"what is the user asking about."* These are two independent axes, not one refined into the other. I'd recommend keeping them as two distinct, cross-referenced concepts rather than collapsing Category A/B/C into a replacement for Direct Question/Business Scenario/Decision Support/Process Guidance. I'm calling this new axis **"Response Mode"** below, but the exact term is a naming call for you, not a conceptual one — "Reasoning Latitude" and "Construction Policy" are reasonable alternatives with the same meaning.

---

## 3. Risks

**Risk of doing nothing:** this is a real product-philosophy tension, not a minor UX complaint. `CLAUDE.md` itself states the target experience should feel "closer to Claude, ChatGPT, or Notion AI... not an internal corporate application," and that "the objective is not to expose information — the objective is to make people more capable." A system that reliably declines to help *do the work*, even while being factually careful, is optimizing for the wrong thing per Hubi's own founding philosophy. Left unaddressed, this plausibly compounds the already-reported "long, low-confidence answers" problem from `Implementation_Handoff.md` Section 6 — over-hedging and low perceived usefulness may be the same underlying phenomenon observed from two different angles.

**Risk of doing this wrong (the more important risk):** loosening grounding latitude broadly, without a precise boundary, directly threatens the two hardest-won lessons of Findings #001/#002 — that a confident-but-wrong answer is worse than an honest non-answer, and that this exact failure mode is empirically real and Product-rated Critical. If Category C's "construction latitude" is ever allowed to touch a *factual* claim (a specific number, an eligibility rule, a regional process detail) rather than only framing/structure, this reopens exactly that risk in a new place. The boundary must be enforced at the level of *individual claims within a response*, not at the level of *entire responses* — a response can be mostly-constructed and still have zero invented facts in it, and the policy needs to be precise enough to guarantee that, not just gesture at it.

**Risk of misclassification:** Architecture.md's own Decision Support example — *"Can I offer a 60% discount?"* — is a facts-and-policy question dressed as a conversational request, similar in surface form to some Category C requests. A classifier (human-written rules or model-driven) that miscategorizes this kind of question as Category C would grant construction latitude exactly where Category A's strictness is non-negotiable. This is the same class of risk this project has already been burned by once (region as an unstated default in Finding #002) — worth taking at least as seriously here.

**Regression risk against already-validated behavior:** `Prototype_Plan.md` Appendix C/D document specific, confirmed-working safe-refusal scenarios (the nonsense-query test, the EU-competitors refusal). Any change here needs to preserve those exact behaviors as regression scenarios — Category C latitude must never generalize into "always try to construct something," which would undo the confirmed-safe refusal behavior for genuinely out-of-scope requests.

**Scope risk:** this proposal touches `Product_Architecture.md`'s definition of Reasoning, `Architecture.md`'s Request Classification, and the not-yet-built Grounded Response Builder simultaneously. Per this project's own operating model (`CLAUDE.md`: pause when a decision affects product vision, user experience, or scope), this is squarely a decision to make with you before any implementation — which matches exactly what you asked for.

---

## 4. Recommendation

**Yes — formalize this as a real architectural concept, not a prompt tweak.** The evidence supports your diagnosis: Hubi is applying one grounding policy to two (at least) structurally different jobs, and the current conceptual architecture doesn't yet have a documented answer for the second job.

**Recommended shape, pending your decisions below:**
- Keep Request Classification (Architecture.md's four types) as the "what is the user asking about" axis — unchanged.
- Introduce **Response Mode** as a second, orthogonal axis governing "how much construction latitude does Reasoning have over already-grounded knowledge" — with three values matching your proposal (Grounded Fact / Grounded Synthesis / Grounded Assistance, naming open).
- Response Mode sits *downstream* of the Applicability Layer, never upstream of it — it changes what Reasoning is allowed to *do* with knowledge that has already passed eligibility/applicability gating. It never changes *which* knowledge is eligible or applicable. This preserves "AI reasoning should only occur after governance and applicability constraints are satisfied" exactly as documented, with zero exception.
- The boundary enforced by Response Mode is at the **claim level**, not the **response level**: Grounded Assistance permits constructing sentences, structure, and framing; it does not, ever, permit a specific factual claim (a number, a policy, a regional rule) that isn't traceable to retrieved knowledge. This needs to be explicit in whatever eventually replaces today's blanket "ground every substantive claim" rule, not implied.

**Before any implementation, decisions needed from you (this is the actual next step, not code):**
1. Confirm the three-category (or refined) framework as the right shape — or adjust it.
2. Work through the Category C internal boundary flagged in Section 2 (constructing an artifact vs. deciding the user's strategy/position) with a few real examples from your list (objection handling and negotiation prep are the ones most likely to need a sub-distinction).
3. Decide whether Response Mode is assigned per-request (e.g., inferred each turn, the way clarifying questions are today) or per-conversation (e.g., set once a business-assistance intent is established) — this affects how a request like Turn 2 in your test ("a company from financial industry, Enterprise") should be handled, since it's a *continuation* of a Category C conversation, not a new request in isolation.
4. Decide how Response Mode interacts with the Context/Applicability Layer's clarification rules — does a Grounded Assistance request still trigger a clarifying question when required business context (region, segment) is missing, or does it proceed with a caveat? Product_Architecture.md's existing precedence rules suggest clarification should still win when context is genuinely required, but this hasn't been tested against a construction-latitude request yet.
5. Only once 1–4 are settled: scope an implementation plan (prompt restructuring, and possibly a lightweight classifier — the same build/don't-build question Request Classification itself has been deferred on) as its own milestone, separate from Findings #001/#002/#003.

---

## 5. Proposed New Product Architecture Capability (conceptual only — no implementation)

### Response Mode

**Definition:** the second, orthogonal classification (alongside Request Classification) that determines how much construction latitude Reasoning has over already-eligible, already-applicable knowledge for the current request. Where Request Classification answers "what is the user asking about," Response Mode answers "what standard of grounding applies to the words Reasoning is about to produce."

**Values (naming open to Product):**
- **Grounded Fact** — every substantive claim must trace to a specific retrieved passage. No construction beyond direct answer + citation. (Today's only mode, applied universally.)
- **Grounded Synthesis** — claims must still trace to retrieved knowledge, but may be combined, summarized, and reorganized across multiple sources into one coherent answer.
- **Grounded Assistance** — Reasoning may construct a new work product (message, pitch, question set, prep document) using grounded facts as verified inputs. Structure, tone, framing, and connective language may be generated; any specific factual claim embedded in that output must still trace to grounded knowledge, with no exception.

**Where it sits in the existing architecture** (extending, not replacing, `Architecture.md`'s Section 3/4/5 flow):

```
Request Classification  (what is the user asking about — unchanged, 4 existing types)
        │
        ▼
Context Builder  (unchanged)
        │
        ▼
Response Mode  (NEW — how much construction latitude applies, independent of the above)
        │
        ▼
Knowledge Engine → Applicability Layer  (unchanged — governs identically regardless of Response Mode)
        │
        ▼
Grounded Response Builder  (behavior now varies by Response Mode, within the same eligible/applicable knowledge)
```

**Hard invariant, stated explicitly so it can't be lost in implementation later:** Response Mode never widens *which* knowledge is eligible or applicable — only *what Reasoning may construct* from knowledge that was already going to be eligible and applicable under Grounded Fact mode. A request in Grounded Assistance mode that lacks sufficient applicable knowledge must still ask a clarifying question or refuse, exactly as it would today — Response Mode is not a way around the Applicability Layer, it's a capability that only activates after the Applicability Layer has already done its job.

**Relationship to existing Request Classification types (a starting hypothesis for Product to confirm, not a decision):**

| Request type | Likely default Response Mode |
|---|---|
| Direct Question | Grounded Fact |
| Process Guidance | Grounded Fact |
| Decision Support | Grounded Synthesis (present options/trade-offs; never construct the user's decision) |
| Business Scenario | Grounded Synthesis by default; **Grounded Assistance when the user is explicitly asking Hubi to produce a work product** (this is the fuzzy boundary flagged in Section 4.2 and needs real examples worked through with you) |

This table is deliberately a hypothesis, not a proposal to build — per your instruction, nothing here should be treated as a decision until you've confirmed it.
