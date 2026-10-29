# Path to Corporate Production (ISSTD28): readiness picture and promotion plan

Status: plan only, 2026-10-29 (revised the same day with the owner's decisions and the existing InfoSec approval). Nothing was deployed, requested or changed in GCP. This maps Hubi against ISSTD28 (GCP Corporate Production Environment Standard, v1.0) using the `wh-gcp-security` canonical copy (`canonical/ISSTD28-canonical.md`). Section references like `§5.1` are the standard's. Statements marked **plugin reading** are the compliance plugin's interpretation, not standard text. Hubi's own facts come from this repository; anything I could not verify is marked `[confirm]`.

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

**What I read.** The intake document you linked ("AI Assessment & Use Case Intake Template", title "Hubi AI", dated May 28, 2026, submission type C: internally built AI product) and I tried the Jira ticket ISSD-51294. **The Jira ticket is not readable from here** (the Atlassian connector returned 403 "app not installed on this instance"). The intake document is the **submission**, not the decision: its Review Status Log, Reviewed by, CBRA scoring and Decision record are all blank, and its status says "In progress". So I know exactly what InfoSec was *asked* to approve on 2026-05-28, but not what they decided, the CBRA risk tier, or any conditions. Those live in the ticket. **I need you to paste the decision comment, the tier and any conditions or follow-up tickets.** Everything below that depends on them is marked.

**How the standard treats the approval (`§5.1`; the effort point is plugin reading).** ISSTD28 requires LT, InfoSec and Infrastructure & Data approval for every Corporate Production project, and a Sandbox attestation does not carry over. The earlier approval therefore cannot replace the InfoSec decision in the promotion chain. It is evidence that makes it a delta review.

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
| **Primary model and provider** | "Anthropic Claude as the primary LLM through approved enterprise access"; external dependencies "Anthropic Claude API, Google Cloud Platform"; Gemini "may also be evaluated" | **Gemini 2.5 Flash on Vertex AI**, in the company's GCP project, no Anthropic dependency | Gemini was left open, so it is within the submission's wording, but the review was framed around Claude. Vertex AI keeps prompts inside Wellhub's GCP, which is arguably a better data story. InfoSec should confirm it explicitly. Also the model-training prohibition (`§5.3`) must be confirmed for this configuration |
| **Logging and storage of user text** | "Logging and retention policies will be defined in partnership with InfoSec during implementation. **No final storage architecture has been approved yet.**" Logged: retrieval requests, AI requests and responses, errors, access events | Every question, answer, history digest, verification draft and claim-ledger quote goes to **Cloud Logging** as structured JSON. The submission anticipated the logging but left the storage architecture and retention **unapproved**. The form's own minimum for AI action logs is 12 months, ISSTD28 says 365 days centrally | The most important item. The approval did not settle this; InfoSec was to define it. This is also where an accidental prospect name would be stored |
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

Do not present this as a new request. Send InfoSec a **delta note** against ISSD-51294 covering the five rows that matter (model and provider, logging and retention, document creation, the redone worst-case assessment, user-entered data) and ask them to either extend the existing approval or tell you what they need re-reviewed. Ask in the same message for the CBRA tier and conditions, whether Vertex AI needs the gateway, and whether the production promotion can reference the earlier approval as the InfoSec step's starting point. I can draft that note when you have the decision details.

## 4. Readiness against the seven promotion criteria (`§5.1`)

All seven must be evidenced. The Project Owner assembles and attests; the approval chain decides. A Project Owner cannot self-approve.

| | Criterion | State | Who closes it |
|---|---|---|---|
| (a) | Classification confirmed (InfoSec + LT, Legal if personal data) | **Pending.** Proposed as Corporate Production; InfoSec confirmation can reference the earlier review; LT and Legal still to confirm | Owner proposes; InfoSec, LT, Legal confirm |
| (b) | Unified approvals: LT, InfoSec, Infrastructure & Data (+ Legal, + CorpTech only if its support is requested) | **Pending, by design.** The earlier InfoSec approval is evidence for the InfoSec step, not the decision | Other people only |
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
1. Paste the **decision, CBRA tier and conditions from ISSD-51294** (the ticket is not readable from here). Section 3 is written against the submission only.
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
- **The earlier approval left logging and retention open** and was framed around Claude, not Gemini. Treat both as unresolved until the decision comment says otherwise.
- **Region:** the production network is `us-east4`; Vertex AI model availability and latency there are unverified.
- **Ownership concentration:** product, engineering and the repository sit with one person today. The standard's "no single-person dependency" expectation needs a team behind the name.
- **Ambiguities in the standard itself** (raised by the compliance plugin): the training course names, the load balancer and pipeline specifics, "where applicable" for backup, and the definition of LT.

## 8. Cost and effort, honestly

Phase 1 is a few engineering days on top of what exists (the resilience, governance, logging and deploy foundations are the same controls the standard asks for). Phases 0 and 2 are calendar time on other teams: durations are set by intake queues and approvals that this repository cannot shorten. A reasonable planning assumption is weeks, not days, from intake to go-live. That estimate is mine, not Platform Engineering's. The existing InfoSec approval should shorten InfoSec's step; it does not remove it.
