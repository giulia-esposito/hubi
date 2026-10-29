# Path to Corporate Production (ISSTD28): readiness picture and promotion plan

> **Read section 0 first.** On 2026-10-29 the V1 scope was set as the web app in the Sandbox for a controlled audience, with Google Chat revisited afterwards. Section 0 says what is and is not a launch blocker; sections 1 to 8 are the later, fuller Corporate Production plan.

Status: plan only, 2026-10-29 (revised the same day with the owner's decisions and the existing InfoSec approval). Nothing was deployed, requested or changed in GCP. This maps Hubi against ISSTD28 (GCP Corporate Production Environment Standard, v1.0) using the `wh-gcp-security` canonical copy (`canonical/ISSTD28-canonical.md`). Section references like `§5.1` are the standard's. Statements marked **plugin reading** are the compliance plugin's interpretation, not standard text. Hubi's own facts come from this repository; anything I could not verify is marked `[confirm]`.

## 0. V1 scope (decided 2026-10-29, revised the same day) and its launch gates

**This section overrides the rest of the document where they disagree.** Sections 1 to 8 are the later, fuller Corporate Production plan; section 0 is what has to be true to launch V1 to a controlled audience.

### 0.1 Decisions

| Topic | Decision |
|---|---|
| **Priority** | The reasoning and retrieval product comes first, not the channel |
| **Channel** | **V1 is the web app in the Sandbox.** Google Chat stays the preferred channel but must not delay Hubi: it goes in only if the Chat-to-backend path needs no significant new infrastructure or platform work; otherwise it is revisited after launch (0.5) |
| **Environment** | **Sandbox** (`wh-revenue-sandbox`, `hubi-pilot`). Not a blocker. Revisit only on a concrete Sandbox limitation. A later Production move is supported by IT and Platform |
| **Authentication** | No custom login, authorization or user-level access work. The existing Workspace sign-in in front of the pilot service (IAP) stays as it is; nothing is built on top |
| **Conversation state** | Temporary history with a time-to-live (TTL), keyed by conversation, with an explicit "New conversation" action. Context is lost only on a deliberate new conversation or when the TTL expires, never because infrastructure restarted (0.2) |
| **Contextual applicability** | Hubi does not ask for country, tier, segment or role by default. It asks only when that context materially changes the answer. Measure first, strengthen only the dimensions that fail (0.3) |
| **Content access** | The Hubi corpus is the access boundary. The rule is Hubi eligibility: content the Content Registry says is not to be added to Hubi is excluded; content explicitly approved for Hubi can be retrieved, whether Client Facing or Internal Wellhub. No access-level system (0.4) |
| **Logging** | Actor logging stays off. Interaction telemetry stays on: questions, outputs, sources and retrieval context, feedback, latency, errors and runtime metadata, with no user identity by default (0.6) |

### 0.2 Conversation state: the lowest-complexity way to get the behaviour you asked for

Today the browser already carries the whole conversation with every request and the server rebuilds the session from it. So an instance restart or a redeploy loses **nothing** already. What is lost today is the browser's own copy: a page reload or a closed tab empties the conversation, because the messages live only in the page's memory. That is the only gap between today and your requirement.

| Option | Survives restart / redeploy | Survives reload | Cross-device | New infrastructure | New data-handling | Complexity |
|---|---|---|---|---|---|---|
| **A. Persist the conversation in the browser with a TTL** (local storage, one entry per conversation) | Yes (server holds nothing) | Yes | No (per browser) | None | None on the server. Text sits in the user's own browser profile | **Lowest: about a day, no platform work** |
| B. Server memory (the old fallback) | No: lost on restart, redeploy and scale-out | n/a | Yes | None | In memory only | Already exists; rejected |
| C. Server store with TTL (Firestore, Memorystore, a bucket) | Yes | Yes | Yes | A database, IAM, a TTL policy | Conversation text stored server-side: touches the InfoSec approval's "persistent memory" re-score trigger | Days, plus platform and InfoSec work |

**Recommendation: A.** It delivers exactly the behaviour you described with no infrastructure, and it keeps the approved design literally true (per-session context, nothing persistent on the server). Its limits are honest ones: no cross-device continuity, and conversation text sits in the user's own browser profile (on a shared or unmanaged browser another person could read it; on a normal Workspace laptop that is the same exposure as any open tab or browser history). It does not make Google Chat harder later: Chat needs option C or a thread read through the Chat API, and that is a separate decision (0.5).

What it means in behaviour:
- One stored entry per conversation, with the messages, sources, pinned context and feedback state.
- A TTL on inactivity (I propose 24 hours, a single constant; your call). On open, an expired entry is dropped, and the user sees a fresh conversation.
- "New session" becomes **"New conversation"**: it clears the stored entry and starts clean.
- The caps already in the server (24 turns, size limits, the truncation notice) still apply, so a very long conversation never loses context silently.
- The server-side session fallback stays for older clients and is untouched.

### 0.3 Contextual applicability: ask only when it changes the answer

**What exists.** A region gate (approved region map, pinned context, must-clarify when the only matching sources are region-specific, no-applicable-content when the region does not match) and guided clarification in Business Assistance.

**What is not measured.** Whether Hubi asks about segment, tier, role or stage when it should, and, just as important, whether it stays quiet when it should. Asking by default adds friction; failing to ask where the answer differs gives a confident wrong answer. Both are failures.

**The evals (start now).** Extend the applicability eval with two kinds of scenario, built on the real corpus:
1. **Must ask**: questions where the answer materially depends on a dimension, for example client onboarding (tier 0, 1, 2 in the Spanish SSL process), contract adherence (T3/T4), Enterprise versus SMB pricing narrative, service level by tier, region-specific processes, role-specific coaching. Pass: Hubi asks a short targeted question naming the choices before giving process content, and does not answer for the wrong value.
2. **Must not ask**: general questions where context does not change the answer (what is Per Subscriber pricing, how cadences work, what is the Golden Pitch). Pass: Hubi answers without a clarifying question.
Report, per dimension: ask-when-needed rate, over-ask rate, and the answers given before asking. Then strengthen only what fails, using the mechanism that fits: label-driven (when sources carry audience, tier or region labels) or conflict-driven (when the retrieved sources disagree). **The pass bar is for Product to set once the first numbers exist;** I will not invent one.

**Known limit that shapes the result.** About 71 percent of the chunks come from five files that carry no audience, region or tier labels (Slide Library, Sales Tools Playbook, Pricing Playbook, Rules of Engagement, Golden Pitch). Where a dimension is not labelled, only the conflict-driven route and the model's own judgment are available. If the evals show failures concentrated in those files, labelling them (a Content task) is the highest-yield fix, ahead of more code.

### 0.4 Content access: eligibility is the rule

This is what the governance gate already does, so nothing needs to be built:
- **Excluded:** anything the registry marks `Not Eligible`, `Pending Assessment`, blank (Unassessed), or Archived/Deprecated, and any `RKC-` identifier the registry does not list.
- **Retrievable:** `Eligible` and `Eligible with Restrictions` (with the restriction caveat shown), regardless of Access Level or Client-shareable. Client Facing and Internal Wellhub content that Content has approved for Hubi is in scope.
- **The access-level guard I proposed earlier is dropped.**

One residual risk to accept in writing, since Hubi will not know who asks: if Content ever marks a Leaders-only or otherwise restricted document `Eligible`, Hubi will serve it to every user. The control is Content's discipline in setting AI Eligibility, which is the same control the original Finding #002 decision already relies on. A short note to the Content owners ("Eligible means anyone using Hubi can read it") is worth sending.

### 0.5 Google Chat: revisit after launch, with a decision rule

Chat goes into V1 only if it is cheap. My reading, which I could not fully confirm from Google's documentation:
- An HTTP-endpoint Chat app is called by Google from outside, which cannot reach an internal-ingress service. Google's documented pattern for this is the **Pub/Sub connection** (Chat publishes events to a topic; the app picks them up; replies go through the Chat API with the app's service identity): [Chat app behind a firewall with Pub/Sub](https://developers.google.com/chat/how-tos/pub-sub), [quickstart](https://developers.google.com/workspace/add-ons/chat/quickstart-pubsub).
- Chat delivers one message at a time, so continuity needs **server-side thread state** (option C above, or reading the thread through the Chat API). That conflicts with the no-silent-loss requirement unless there is a durable store.
- So Chat means a Pub/Sub topic and subscription, a Chat app configuration and Workspace admin approval, an always-on receiver, and a durable TTL store. That is **more than "no significant infrastructure"**, so under your rule the default is **web app first, Chat afterwards**.

**Decision rule, in one question for Platform Engineering:** "Can I, in `wh-revenue-sandbox`, create a Pub/Sub topic and subscription for a Google Chat app, run an always-on receiver, and use a managed store with a TTL, without a ticket queue?" If all three are self-service, a Chat spike is a few days and can run in parallel. If any needs a queue, defer Chat. Nothing in the web launch depends on the answer. Preparatory refactoring of the turn pipeline for Chat (a shared `runTurn` core) is not started and is no longer on the V1 path.

### 0.6 Logging and telemetry for evaluation

Already in place and sufficient for V1: question, answer, sources and retrieval context (raw top results, applicability decision, fact pass, query expansion), verification and attribution results, planning mode and turn kind, latency (total and model), engine attempts, errors, feedback with tags, and the build that produced each turn. Identity is not logged: `sessionId` is a random browser-generated id, and actor logging (`HUBI_LOG_ACTOR`) is off. Emails and phone-like numbers are scrubbed from the text fields. The persisted conversation in 0.2 keeps that id across a reload, which links a person's turns to each other but not to the person.

### 0.7 Launch gates for a controlled audience, web app in the Sandbox

**Launch blockers**

| # | Item | Type | Who |
|---|---|---|---|
| 1 | **Contextual applicability evals run, and the dimensions that fail are strengthened to a bar Product sets** | Build | Engineering builds and measures; Product sets the bar |
| 2 | **Conversation persistence with TTL and "New conversation"** (option A) | Build | Engineering; you pick the TTL (proposed 24 hours) |
| 3 | **Deploy the current build** by the runbook route and verify it (the live revision predates all of this work). Includes the first build with `USER node` | Approval and verification | You approve; the runbook exists |
| 4 | **Tester access to the Sandbox service**: how the named audience reaches the URL and gets through the existing sign-in (the service is internal-ingress and IAP-protected) | External | Sandbox and IAP owners; I have not verified how access is granted today |
| 5 | **Audience briefed and rollback known**: AI drafts must be checked, how to give feedback, and who rolls back and how | Owner | You |
| 6 | **Log retention decided** for the pilot's logs (they hold scrubbed question and answer text) | Decision | You, with InfoSec if you want their view |

**No longer launch blockers**

- Google Chat integration, the Pub/Sub path, thread-keyed server-side state, the Chat app configuration and Chat feedback cards (all move to the post-launch Chat revisit, 0.5).
- Sandbox versus Production (decided: Sandbox).
- The access-level guard (dropped: eligibility is the rule).
- Custom authentication, authorization and actor logging (off, non-blocking; `§5.6` lists the acting user for Corporate Production, so it returns as a promotion item or an InfoSec exception).
- The InfoSec delta note, the DPIA determination and the full ISSTD28 chain (LT, InfoSec and Infrastructure and Data approval, RASCI sign-off, Catalog, pipeline, monitoring integration, FinOps, training, coverage model): needed before Production or widening, not for a controlled Sandbox audience. I keep one caveat: the InfoSec approval says its open items close before production go-live. Treating a controlled Sandbox pilot as not "production go-live" is my reading; if InfoSec reads it differently, the delta note moves back onto this list.
- Finding #005 (claim fidelity): remains release-blocking for wider rollout only, as decided earlier; the AI-draft label is in.
- Repository move to the company organisation, SAST pass, bucket versioning, decision-trace logging: before Production.

**Already done:** log scrubbing, circuit breaker, request guard, retries, AI-draft label, usage guidelines, claim guardrail, governance registry, retrieval benchmark and cross-language expansion.

## 1. What Hubi is, in the standard's terms

- **Classification: Corporate Production.** Hubi is an internal tool used by Revenue teams and does not deliver the Wellhub platform to clients (`§4`, `§5.1`). The Project Owner proposes the classification; InfoSec and the LT confirm it, and Legal confirms it too if personal or regulated data is processed.
- **Route: promotion, not provisioning.** A Sandbox project is never by itself eligible for production traffic; the solution is rebuilt or hardened (`§5.1`). The hosting project would be `wh-revenue-prd-corp` (registry: ACTIVE, staging pair `wh-revenue-stg-corp`, access group `revenue-corporate-production`, region `us-east4`, shared VPC host `networking-500210`).
- **Deployment model:** Cloud Run service (`the standard`, `§5.5`); AI agent: yes (so rate limits, circuit breakers and decision-trace logging apply).
- **Not Platform Production.** If anyone proposes exposing Hubi to clients, this standard no longer applies and the path changes entirely.

## 2. Decisions recorded (owner, 2026-10-29) and what the standard actually requires

| Decision | What you said | What ISSTD28 requires | Status |
|---|---|---|---|
| **Project Owner (R)** | Marina Michel, G6+, your leader and senior owner of the Revenue Strategy & Operations structure where Hubi sits. You remain product and operational owner | One named individual, **job grade G6 or above**, explicitly identified by the respective LT or ELT (`§4`, `§5.1`, `§5.4`). R owns design, secure configuration, upkeep and 24x7 operation of the project and its AI agents (`§6.1`). The grade cannot be verified from here: recorded as asserted | Matches the registry, which already lists Marina Michel as GCP Project Owner of `wh-revenue-prd-corp`. Needs her own agreement to the RASCI and her typed acknowledgment (`§6.5`) |
| **Accountable (A)** | Fabio Lima is the A (confirmed by the owner, 2026-10-29) | **A must be an LT member** (a named person, not an organisation or function): owns budget, risk acceptance and policy compliance for the domain, and escalates exceptions to the ELT (`§5.1`, `§6.1`). The LT approval in the chain is also an LT decision (`§5.1`) | Recorded as A. The standard requires the A to be an LT member and I cannot verify his membership from the standard or the registry (`§4` defines LT but the canonical copy does not restate it). InfoSec and the LT confirm the role during the approval chain, so this resolves itself there; if his role does not qualify, the A becomes the LT member above him and nothing else in the plan changes |
| **On-call** | You as primary product/business owner, Marina as escalation; you do not want to invent a technical on-call model | See 2.1 | **Open, needs a decision before assigning** |
| **Data** | Conservatively assume prospect and client business details may count as customer data; users are not expected to enter names, emails or other identifiable personal data; questions are about internal processes | Customer data or sensitive PII triggers the DPIA gate: DPIA completed and Legal Privacy approval **before** processing starts, reconfirmed at go-live (`§5.9`). Internal data, including employee records, has no extra gate | See 2.2 |

### 2.1 On-call: exactly what the standard says, and does not say

**Stated by the standard (`§5.1`, `§6.1`, `§6.2`):**
- R (the Project Owner) is responsible for **24x7 (365 days)** operation of the project and its AI agents, including maintenance, incident resolution and backup/DR configuration. R and A are "jointly and fully responsible", "no exemptions".
- "You build it, you run it." Neither InfoSec nor CorpTech is R by default. CorpTech may maintain it only if the LT explicitly requests and documents that; general tickets are not routed to CorpTech otherwise.
- Agent-flagged standard findings must be remediated within **2 business days**. A severe or critical finding (public exposure, an exposed secret, an actively exploitable vulnerability) can be **auto-blocked or quarantined without waiting**; it stays blocked until a fix is applied and verified (`§5.2`).
- Security incidents (credential leakage, improper PII exposure, suspected compromise) are reported **immediately** through Jira InfoSec Incident Management or `infosec@gympass.com` (ISSTD02) (`§5.10`).
- A **Support SLA** (hours, response targets by severity, accountable team) is **strongly recommended, not a gate**; a lightweight or area-level template is acceptable. **The RASCI is not optional.**

**Not stated by the standard:** a required technical role or job title for the responder; numeric response or resolution times for incidents (only the 2-business-day finding SLA, and ISSTD18 for vulnerabilities, which I have not read); a staffed rota or paging tool. So the standard does not require an engineering on-call team, and it does not allow "business hours only" to be read as a waiver of the 24x7 responsibility either. **Plugin reading:** the owner defines coverage in the Support SLA, but the owner is the one accountable if an incident lands out of hours.

**What the architecture already does for you:** a rollback is one scripted command; the service is stateless; requests are rate limited and bounded. An out-of-hours incident is therefore mostly "stop the bleeding by rolling back or disabling", which a non-engineer owner can authorise but cannot perform: **in production nobody has standing write access** (`§5.4`: Viewer by default, write only per request, no human `actAs`). The actual rollback or fix runs through the deployment pipeline's identity, by someone with approval to operate it.

**Decision needed from you and Marina:**
1. Who is the **named technical maintainer**: a person (or team) who can operate the pipeline, remediate a scanner finding inside 2 business days, and roll back? An AI coding assistant cannot be that person. Today I do not know of one besides the build itself.
2. Which coverage model goes into the Support SLA? Options, in order of how closely they follow the standard's wording: (a) 24x7 with a rota or paging channel (needs more than one person); (b) business-hours response targets plus a named escalation path (you, then Marina) and a documented kill switch, with the out-of-hours gap stated openly in the SLA and accepted in writing by the Accountable; (c) ask CorpTech or Platform Engineering to operate it, which needs the LT to request and document it. I recommend (b) for a Revenue productivity tool and raising it with InfoSec as a stated position, not hiding it. It is a risk acceptance, and risk acceptance sits with the Accountable LT member.
3. Whether a **kill switch** is acceptable as the out-of-hours safe state (for example a documented command that scales the service to zero), and who may trigger it.

### 2.2 Data: how your assumption plays out

Your assumption (treat prospect and client details as potentially customer data, avoid PII) is the right conservative starting point. Things to make explicit:
- Hubi's **inputs** are questions about internal processes; its **knowledge** is internal Revenue content. Neither is customer data by design. The exposure is accidental: a rep pastes a prospect name or a contact into a question.
- The conservative record, pending Legal Privacy: `contains_customer_data_or_sensitive_pii: true`, `dpia: required`. Legal may determine the DPIA does not apply because the product forbids and discourages such input; that is Legal's decision, so I recorded the cautious value rather than the optimistic one.
- **What actually reduces the question:** (1) a visible notice in the Hubi UI telling users not to enter personal data or confidential client information (Product decision, copy needed); (2) minimising what is stored: the pilot logs questions and answers in full (see section 3, "Changed since the baseline"); (3) a pattern scrubber on logged text for emails and phone numbers. With these in place, the honest answer to Legal is "not designed to receive it, discouraged, filtered before storage".
- Classification label values are ISSTD06 levels (`confidential`, `internal`, `public`). I propose `internal` for the content and the service, and treating logs as `confidential` until the redaction work is done. InfoSec confirms.

## 3. The existing InfoSec approval: baseline, documentation, new, and changed

**What I read.** The intake submission ("Hubi AI", dated May 28, 2026, type C), the Jira activity you pasted for ISSD-51294 (the ticket itself is not readable from here: the Atlassian connector returns 403), and the InfoSec risk assessment document attached to the ticket on 2026-06-16, which carries the CBRA scoring and the decision. Hubi was **Approved on 2026-06-09, CBRA 4 (Low)**.

**How the standard treats the approval (`§5.1`; the effort point is plugin reading).** ISSTD28 requires LT, InfoSec and Infrastructure & Data approval for every Corporate Production project, and a Sandbox attestation does not carry over. The earlier approval therefore cannot replace the InfoSec decision in the promotion chain. It is evidence that makes it a delta review.

### 3.0 The decision (ISSD-51294, read from the Jira activity you pasted and the risk assessment document attached on 2026-06-16)

| | |
|---|---|
| Submitted | 2026-05-28, type C (internally built AI product), author Giulia Esposito (Revenue Strategy and Enablement) |
| Decision | **Approved**, 2026-06-09, by Guilherme Crucillo (InfoSec). Ticket resolved Done the same day; the risk assessment document was attached on 2026-06-16 |
| CBRA score | **4, Low** (Criticality 2 x Autonomy 1 x Permissions 2 x Impact 1). "Approve, standard baseline controls apply"; required approvals: InfoSec review only. DPO/Legal review was not triggered |
| Basis | Advisory only, Internal-classified data, no write access, no MCP or tool calling, no autonomous action. InfoSec calls these design choices "the primary risk mitigants" that "must be preserved as the architecture evolves" |
| Condition stated | **Re-score trigger.** The approval covers: Internal-data RAG, no MCP servers, no write access, single agent, about 700 Revenue users. A **new assessment submission** is required for any of: (a) Confidential or client data in the knowledge base, (b) MCP servers or tool calling, (c) WorkRamp or any system involving personal data, (d) persistent memory, (e) expansion beyond the Revenue organisation. "Do not proceed with these changes under this approval." |
| Also said | The approval "is conditional on the architectural commitments stated in the form being honoured", several open items "represent material unknowns", and "**the conditions below must be closed before production go-live**". Only the re-score condition is written below that sentence in the document I read, so the other open items are implied rather than listed: the API gateway approach (TBD), the LLM provider's DPA status, the final architecture and secrets approach, and the retention architecture. Worth asking Guilherme whether any other condition exists |

**Two things in the assessment worth raising with InfoSec.**
1. **The Impact Radius row is internally inconsistent.** It shows a score of 1 (and the total of 4 uses 1), but the rationale says "Scored conservatively at 2 given deployment breadth". With Impact at 2 the total is 8, which is **Medium** ("approve with conditions, InfoSec + CISO awareness"), not Low. This matters because ISSTD28's InfoSec step will likely start from this tier. Ask Guilherme which is right.
2. **The score rests on assumptions that have since moved**: "Anthropic Claude via GCP" as the external LLM, a worst case of "minor rework", and "future versions may log interactions". See 3.2.

**Re-score triggers checked against Hubi today**

| Trigger | Hubi | Status |
|---|---|---|
| (a) Confidential or client data in the knowledge base | Knowledge content is Internal (the Content Registry holds "Client-shareable: No" on every row). The risk is **user-typed** prospect details, which are not the knowledge base | Not triggered, but see 3.2 (user input was never assessed) |
| (b) MCP servers or tool calling | None | Not triggered. **Keep it that way: Phase 1 must not add tools** |
| (c) WorkRamp or any system involving personal data | No integration; the content is a file export | Not triggered. A future WorkRamp sync would trigger a new assessment |
| (d) Persistent memory | The agent has none; each session starts empty. Conversation text is persisted in Cloud Logging for monitoring, which is not memory the agent reads | Not literally triggered; a judgment call InfoSec should confirm, because it is the same retention question |
| (e) Expansion beyond the Revenue organisation | Revenue only | Not triggered. Promoting to Corporate Production under `wh-revenue-prd-corp` does not widen the audience |

### 3.1 What was submitted, and where Hubi still matches it

| Submitted on 2026-05-28 | Hubi today | Verdict |
|---|---|---|
| Internal knowledge assistant for Revenue (about 700 users), retrieval from approved Revenue knowledge sources, source references on answers | Same | Matches |
| Advisory only: no autonomous actions, no tool calling or MCP, no writes to any Wellhub system, cannot send communications, single agent, human owns every decision | Same. No MCP, no tools, no write access | Matches |
| Human oversight level 1 (a person checks every output before it is used); worst case rated 2 (a few people, caught quickly) | Same design; the worst-case rating is challenged below | Matches, see 3.3 |
| Session memory: per session only, no persistent memory | The browser holds the conversation in memory for the tab and sends it with each request; only a session id sits in `sessionStorage`. The agent remembers nothing across sessions | Matches |
| Secrets in an approved vault, none in code, prompts or logs | Stricter: no keys and no secrets at all (Application Default Credentials) | Matches, better |
| Data: Revenue enablement material, playbooks, PMM material, all classified Internal; no PII intended in the knowledge base | Same content families, governed by the Content Registry | Matches |
| Read-only access to Revenue repositories; WorkRamp and others "under evaluation" | GCS copy of the Revenue Knowledge Center only; no WorkRamp | Matches |
| Interim web application "for architecture validation and pilot testing", Google Chat as the long-term interface | Web app behind IAP; no Google Chat | Matches |
| Monitoring planned: availability, API failures, retrieval failures, usage, cost, user feedback | Telemetry, feedback and error events exist; availability and cost alerting do not | Partly |
| "AI functionality can be disabled without impacting operational systems; access can be restricted or suspended" | True and scriptable (scale to zero, rollback) | Matches. Useful for the on-call answer (2.1): the approval already commits to a kill switch |

### 3.2 Changed since the submission: needs InfoSec re-validation

| Change | Submitted | Now | Why it matters |
|---|---|---|---|
| **Primary model and provider** | "Anthropic Claude as the primary LLM through approved enterprise access"; external dependencies "Anthropic Claude API, Google Cloud Platform"; Gemini "may also be evaluated". InfoSec's Permissions score of 2 rested on data flowing "to an external LLM API (Anthropic Claude via GCP)" | **Gemini 2.5 Flash on Vertex AI**, in the company's GCP project, no Anthropic dependency | Gemini was left open, so it is within the submission's wording, but the review was framed around Claude. Vertex AI keeps prompts inside Wellhub's GCP, which is arguably a better data story. InfoSec should confirm it explicitly. Also the model-training prohibition (`§5.3`) must be confirmed for this configuration |
| **Logging and storage of user text** | "Logging and retention policies will be defined in partnership with InfoSec during implementation. **No final storage architecture has been approved yet.**" InfoSec flagged "retention architecture undefined" as residual exposure and the open items as conditions to close before go-live. Logged: retrieval requests, AI requests and responses, errors, access events | Every question, answer, history digest, verification draft and claim-ledger quote goes to **Cloud Logging** as structured JSON. The submission anticipated the logging but left the storage architecture and retention **unapproved**. The form's own minimum for AI action logs is 12 months, ISSTD28 says 365 days centrally | The most important item. The approval did not settle this; InfoSec was to define it. This is also where an accidental prospect name would be stored |
| **Declared purposes** | Ticked: research and analysis, summarisation, communication and writing assistance (editing, translating, tone), automated decision support, assistant with tool access. **Not ticked: "Document creation and review (writing emails, reports, presentations)"** | **Business Assistance generates pitches, emails and talk tracks**, which is document creation | Likely outside the declared purposes. It also moves the output from internal guidance to drafts that reps may send to prospects |
| **Worst-case self-assessment** | Level 2: "a small number of people inside Wellhub... caught and fixed quickly"; "minor delays or rework" | With customer-facing drafts and an open claim-fidelity finding (#005: the model can overstate a claim or drop its scope), a plausible worst case is a misleading statement reaching a prospect | The self-assessment should be redone honestly; it probably rises to level 3 (a meaningful problem for a team or process). This feeds InfoSec's CBRA impact score |
| **Data entered by users** | The data table lists knowledge sources only. User questions as input were **not assessed** | Users type free text, which may include prospect or client details by accident | The form's classification guidance says to include everything and flag it. This is the gap behind the DPIA question (2.2) |
| **Calls that carry user text to the model** | One call per question | Up to three: query expansion, generation, and a revision call; the prompt carries a claims-ledger instruction | Same provider and identity, so no new vendor, but more calls per turn and more tokens of user text |
| **Network path to the model** | "Connectivity pattern still under review and aligned with IT"; the form requires calls to external AI APIs to go through an approved gateway (TC3 Agent Gateway or Apigee) | Direct calls to Vertex AI from Cloud Run with the service identity | Open in the original. Ask InfoSec whether Vertex AI inside the company's own project counts as an "external AI API" needing the gateway |
| **Corpus** | PMM materials, playbooks, enablement content as of May | Now includes the 704-chunk PMM Slide Library (ROI statistics, persona stories) and four other files with no registry record | Confirm all of it is within "PMM materials"; register the unregistered files |
| **Hosting history** | A new GCP project was requested (HDT-108552) and "cancelled due to AI Tool approval" | Sandbox project now, `wh-revenue-prd-corp` for production | Close the loop with the platform team: the production project exists in the registry |

**Unchanged:** advisory-only design, no tools or MCP, no write access, human review of outputs, per-session memory, ingress and authentication posture, no secrets.

### 3.3 Already approved, so only documentation in ISSTD28 terms

Workload name, project, invoker (people in a browser), deployment model, AI agent (single, advisory), connectors (Vertex AI and GCS, both read), no MCP, no write access, data classification of the knowledge content (Internal), per-session memory, secrets handling, human oversight, the kill-switch statement. These map directly onto manifest fields; the manifest records them with the intake document as the reference.

### 3.4 Genuinely new in ISSTD28 (not covered by the submission)

- Publication behind the **corporate load balancer and Zscaler** in the production network, egress only through the allowlisted proxy (`§5.5`).
- Deployment through the **standard CI/CD pipeline** or a documented equivalent (`§5.1`).
- **Availability monitoring** with alert routing into the company stack, as a go-live prerequisite (`§5.1`, `§5.6`).
- **24x7 operation model, RASCI with an LT Accountable, Catalog entry**, support coverage (2.1).
- **Production access model**: Viewer by default, per-request write, no human `actAs`, semi-annual access review (`§5.4`).
- **Mandatory log fields** (acting user, source IP), 365-day central retention, **AI decision trace**, **circuit breaker** (`§5.2`, `§5.6`).
- **Registry entries** in the Authorized AI Tools and Connectors Registry. The submission answered "Is this tool in the registry?" without ticking Yes or No; check whether an entry exists.
- **FinOps budget and cost center**, 50/80/100 percent alerts (`§5.8`).
- **Training** (AI Security and Secure SDLC, recertified every 6 months) for everyone authorised on the production project (`§3`).
- **Backup/DR justification**, **lifecycle and decommission sign-off** (`§5.7`, `§5.10`).
- **DPIA determination** by Legal Privacy (`§5.9`).
- **AI-output labelling and human sign-off** for artifacts used in corporate decisions (`§5.3`, `§5.10`).

### 3.5 Recommendation for the InfoSec conversation

Do not present this as a new request. Hubi sits inside the approved scope on every re-score trigger, and the approval already says the open items close before go-live, so the honest framing is a **delta note against ISSD-51294**: here is what the open items resolved to, and here are the five things that moved. A draft is in `docs/infosec-delta-note-ISSD-51294.md`. The questions to put to Guilherme in it: the Impact Radius inconsistency (Low versus Medium), whether any other condition exists, whether Gemini on Vertex AI inside the company project is covered, whether Vertex needs the gateway, whether the earlier approval can be the starting point for the ISSTD28 InfoSec step, and who defines log retention.

## 4. Readiness against the seven promotion criteria (`§5.1`)

All seven must be evidenced. The Project Owner assembles and attests; the approval chain decides. A Project Owner cannot self-approve.

| | Criterion | State | Who closes it |
|---|---|---|---|
| (a) | Classification confirmed (InfoSec + LT, Legal if personal data) | **Pending.** Proposed as Corporate Production; InfoSec confirmation can reference the earlier review; LT and Legal still to confirm | Owner proposes; InfoSec, LT, Legal confirm |
| (b) | Unified approvals: LT, InfoSec, Infrastructure & Data (+ Legal, + CorpTech only if its support is requested) | **Pending, by design.** The 2026-06-09 InfoSec approval (CBRA 4, Low) is evidence for the InfoSec step, not the decision | Other people only |
| (c) | RASCI with a named Responsible and an Accountable **LT** member | **Partly.** R: Marina Michel (asserted G6+); A: Fabio Lima if his role counts as LT. Needs agreement from both, and the coverage model in 2.1 | Owner drafts; A and R agree |
| (d) | Catalog entry: accountable owner, responsible lead, direct contact channel | **Missing.** Row for `wh-revenue-prd-corp` is empty. Proposed: accountable owner Fabio Lima, responsible lead Marina Michel, contact channel a Revenue Strategy & Operations team channel `[confirm]` | Owner writes the row |
| (e) | Production readiness: source control, validated deployment, availability monitoring | **Partly.** See 4.1 | Engineering + Platform Engineering |
| (f) | Backup, RPO/RTO, recovery configured where applicable, or an approved exception | **Closable by justification** (4.2) | Owner writes the justification |
| (g) | Data classified under ISSTD06 (+ DPIA and Legal if customer data or sensitive PII) | **Pending Legal.** Conservative record in section 2.2 | Owner classifies; Legal decides |

### 4.1 Readiness prerequisites (criterion e)

| Prerequisite | Today | Gap |
|---|---|---|
| Source control | Git on a personal GitHub account (`giulia-esposito/hubi`) | Strongly recommended, not mandatory, if documented with a named owner. Move to the Wellhub GitHub organisation before promotion: a personal repository cannot be the system of record for a production tool |
| Deployment with security validation | `scripts/deploy.ts` runs from a developer machine, with rollback and a config diff; CI runs tests only | Manual or ad hoc production deployment without documented security validation is **prohibited**. Needs the standard CI/CD pipeline or a documented equivalent. The pipeline identity, not a person, holds `actAs` on the runtime service account. Pipeline name and identity are not in the canonical registry: `[confirm]` with Platform Engineering. Keep the deploy script's snapshot-and-diff as a post-deploy check |
| Availability monitoring | `/api/health` exists | Needs an uptime check and alert routing into the company monitoring stack (not named in the canonical registry, `[confirm]`) |

### 4.2 Backup and DR (criterion f)

Hubi has no database and no user store. State is: the Content Repository copy in GCS (reproducible from the source documents), the governance snapshot (in git), and logs. **Plugin reading:** "where applicable" means the workload holds persistent state or has a recovery need; a workload that does not is recorded `not-applicable` with the owner's written justification. Draft: stateless service, content re-importable, recovery is redeploying a previous revision (scripted) and re-syncing the bucket. Add object versioning on the content bucket and state an RTO. If anyone disagrees, the route is the Exception Request workflow (`§3`), not a decision the owner records.

## 5. The hardening delta: what Hubi needs

| Area (standard) | Hubi today | Work |
|---|---|---|
| Invocation and ingress (`§5.5`) | Sandbox: internal ingress + IAP | Internal ingress through the **corporate load balancer and Zscaler**, authenticated invocation. How an owner publishes behind it, and whether IAP is the sanctioned authentication, is not in the canonical registry: `[confirm]` with Platform Engineering |
| Runtime identity, secrets (`§5.4`) | Cloud Run service identity via ADC; no keys | Dedicated runtime service account in the production project; no human `actAs`. Already the right shape |
| Egress (`§5.5`) | Vertex AI and GCS | Egress only through the secure web proxy allowlist via the shared VPC (Direct VPC egress on `prd-corp-workload-subnet`). Confirm Vertex AI is reachable on that path and the Gemini model is available in `us-east4` (the pilot runs in `us-central1`) |
| Labels (`§5.4`) | Sandbox-managed | `environment`, `team`, `cost-center`, `data-classification` on the service and resources. Cost center unknown |
| Application logging (`§5.6`) | Structured JSON: UTC timestamp, severity, session and interaction ids | **Add the acting user identifier and source IP.** Apply the plaintext policy from section 2.2 to questions, answers and feedback comments. Central retention (365 days) is the platform's |
| AI agent logging (`§5.6`) | Logs question, retrieved source ids, answer, verification and attribution results, expansion terms, engine attempts | The standard asks for tools and APIs called, their parameters, and the decision trace "model prompts, reasoning steps, selected execution paths". Prompts are not logged today. Decide what trace is sufficient against the plaintext rule |
| Agent limits (`§5.2`) | Per-user and per-instance request caps, concurrency cap, bounded retries | **Circuit breaker not built** |
| Integrations (`§5.3`) | Vertex AI, GCS | Registry entries (section 3.2); each future source needs its own entry and owner approval. Confirm no Wellhub data is used for model training under the Vertex configuration |
| AI output (`§5.3`, `§5.10`) | Drafts for customer-facing use, sources cited | AI-draft label with tool and date, and a documented human sign-off. Product decides the UX. Finding #005 is a separate release gate |
| Budget (`§5.8`) | Sandbox budget | FinOps process for the owning cost center; the Accountable LT member owns it |
| Lifecycle (`§5.10`) | Sandbox 60-day assumption | Decommission needs a business decision and owner sign-off |
| Human access (`§5.4`) | Developer write access in Sandbox | Viewer by default in production; everything changes through the pipeline |

## 6. Plan

**Phase 0: decisions and intake (Giulia, Marina, LT, Legal, InfoSec).**
1. Send the **delta note** (`docs/infosec-delta-note-ISSD-51294.md`) to Guilherme Crucillo after you have read it. Decision, tier and conditions are now in section 3.0.
2. Fabio Lima is recorded as the Accountable; LT membership is confirmed by InfoSec and the LT in the chain.
3. Decide the **coverage model** and **named technical maintainer** (section 2.1).
4. Put the data question to **Legal Privacy**, with the mitigations in 2.2. I can draft the message.
5. Enter the standard prioritization process for promotion.

**Phase 1: engineering, no approvals needed (starts when you say go).** Log the acting user and source IP; minimise and scrub logged text, including feedback comments; log the decision trace the standard asks for; provider circuit breaker; AI-draft label and human sign-off hook (after the Product call); content bucket versioning and an RTO statement; draft the documents the owner signs (RASCI, backup justification, Support SLA, Catalog row, registry entries, kill-switch procedure); move the repository to the Wellhub organisation; run the bundled SAST review and fix confirmed findings.

**Phase 2: platform and security (Platform Engineering, InfoSec, Infrastructure & Data).** Pipeline access and identity; the sanctioned publication path; monitoring and alert routing; egress allowlist entries; label values, cost center, FinOps registration; registry entries; training for everyone authorised; delta review by InfoSec using section 3. Staging in `wh-revenue-stg-corp` only without production data, or ISSTD28 applies to it in full.

**Phase 3: assurance.** Complete the manifest (`.wh-corp-production/workload.yaml`; approvals stay `pending`); deploy through the pipeline; run the guardrail check against the real configuration (expect `INCONCLUSIVE` for controls an owner with Viewer access cannot read: that is the access model working, not a pass); owner attestation in the owner's own words (records evidence, is not the decision); the approval chain decides.

**Phase 4: steady state.** Hypercare with the named maintainer; schedule the drift audit; semi-annual access review; findings fixed inside 2 business days; re-attest after material change.

## 7. Risks worth naming

- **Finding #005 is the content risk, not an infrastructure one.** The claim guardrail is a pilot mitigation and the ledger is observe-only by default. Wider rollout stays gated on it independent of this standard.
- **Persistent user text in logs** is the most likely thing InfoSec questions first, and it is a change from what was reviewed.
- **No technical responder today.** The standard assigns 24x7 operation to the owner; nobody currently holds the pipeline and rollback role in production terms.
- **LT eligibility of the Accountable** (Fabio Lima) is asserted, not verified; InfoSec and the LT confirm it in the chain.
- **The earlier approval left logging and retention open** (a condition to close before go-live) and was framed around Claude, not Gemini. Its Impact Radius row says 1 while its rationale says 2: Low or Medium is unresolved.
- **Region:** the production network is `us-east4`; Vertex AI model availability and latency there are unverified.
- **Ownership concentration:** product, engineering and the repository sit with one person today. The standard's "no single-person dependency" expectation needs a team behind the name.
- **Ambiguities in the standard itself** (raised by the compliance plugin): the training course names, the load balancer and pipeline specifics, "where applicable" for backup, and the definition of LT.

## 8. Cost and effort, honestly

Phase 1 is a few engineering days on top of what exists (the resilience, governance, logging and deploy foundations are the same controls the standard asks for). Phases 0 and 2 are calendar time on other teams: durations are set by intake queues and approvals that this repository cannot shorten. A reasonable planning assumption is weeks, not days, from intake to go-live. That estimate is mine, not Platform Engineering's. The existing InfoSec approval should shorten InfoSec's step; it does not remove it.
