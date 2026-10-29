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
| **Accountable (A)** | Revenue Strategy & Operations leadership, Fabio Lima, as sponsor | **A must be an LT member** (a named person, not an organisation or function): owns budget, risk acceptance and policy compliance for the domain, and escalates exceptions to the ELT (`§5.1`, `§6.1`). The LT approval in the chain is also an LT decision (`§5.1`) | **Open:** I cannot tell from the standard or the registry whether Fabio Lima's role counts as "LT". The standard says "LT" and "ELT" are defined in `§4` but the canonical copy does not restate the definition. Confirm with InfoSec GRC (the standard's author) that his role qualifies; if not, the Accountable is the LT member above him. A sponsor who is not an LT member can be a Consulted party, not the A |
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

**What I know and do not know.** You told me Hubi was reviewed and approved by InfoSec before ISSTD28 existed. Nothing in this repository records that approval: no ticket, date, scope or conditions. I will not guess what it covered. To do this properly I need the approval artifact (ticket or email, date, the version or description of what was reviewed, any conditions). Until then I use the **last deployed revision as a proxy baseline**: `hubi-pilot-00005-s6p`, built from commit `bb23f3c` (2026-10-16), which is what is running in the Sandbox and what was most plausibly reviewed. If the review was earlier or covered less, the "changed" list below is larger.

**How the standard treats it (`§5.1`, plugin reading for the effort point).** ISSTD28 requires approvals from LT, InfoSec and Infrastructure & Data for every Corporate Production project, and the Sandbox attestation does not carry over. So the previous approval **cannot replace** the InfoSec decision in the chain. It can legitimately be evidence that shortens the review, and it makes this a delta review for InfoSec rather than a first look.

### 3.1 Already in place and approved (documentation only, no new work)

By my reading of the repository at the baseline commit. These ISSTD28 fields simply record facts the earlier review would have seen:

| ISSTD28 field / control | Fact at baseline |
|---|---|
| Workload name, project, deployment model, invoker | Cloud Run service `hubi-pilot`, browser users, behind IAP and internal ingress |
| Authenticated invocation, no public exposure (`§5.5`) | IAP plus internal ingress, no `allUsers` |
| No keys, no secrets (`§5.4`, org rule) | Runtime service identity through Application Default Credentials |
| Model path (`§5.3`) | Gemini 2.5 Flash through Vertex AI in the company's own project; no third-party AI vendor |
| Content source | Read-only copy of the Revenue Knowledge Center in GCS; no write access to any Wellhub system |
| Connectors list | Vertex AI and GCS only |
| Content governance | AI Eligibility gate (RKC-000021 excluded) |
| Labels, project ownership | Present on the Sandbox service (registry lists Marina Michel as owner of the production project) |

### 3.2 Genuinely new in ISSTD28 (needs implementation or additional review, not covered by a Sandbox-era review)

- Publication behind the **corporate load balancer and Zscaler** in the production network, and egress only through the allowlisted proxy (`§5.5`).
- Deployment through the **standard CI/CD pipeline** or documented equivalent with security validation; no manual deploy (`§5.1`).
- **Availability monitoring** with alert routing into the company stack, as a go-live prerequisite (`§5.1`, `§5.6`).
- **24x7 operation model, RASCI with an LT Accountable, Catalog entry**, support coverage (section 2.1).
- **Production access model**: Viewer by default, per-request write, no human `actAs`, semi-annual access review (`§5.4`).
- **Mandatory log fields** (acting user, source IP), 365-day central retention, **AI decision trace**, **circuit breaker** on the agent (`§5.2`, `§5.6`).
- **Registry entries** in the Authorized AI Tools and Connectors Registry for Vertex AI and GCS (`§5.3`). If the earlier InfoSec review already produced a registry entry, point to it.
- **FinOps budget and cost center**, 50/80/100 percent alerts (`§5.8`).
- **Training** (AI Security and Secure SDLC, recertified every 6 months) for everyone authorised to touch the production project (`§3`).
- **Backup/DR justification**, **lifecycle and decommission sign-off** (`§5.7`, `§5.10`).
- **DPIA determination** by Legal Privacy (`§5.9`), per section 2.2.
- **AI-output labelling and human sign-off** for artifacts used in corporate decisions (`§5.3`, `§5.10`).

### 3.3 Changed since the baseline: flag for InfoSec re-validation

Diff of `bb23f3c` to the current tree: 59 files, about 6,900 lines added, **no new npm dependency** (only scripts added to `package.json`), **no new external service or egress**: every model call still goes to Vertex AI through the same identity. What did change, by importance:

| Change | Why it matters | Needs |
|---|---|---|
| **Persistent storage of user text.** At the baseline, interaction logs were written to a local file on the container (ephemeral, effectively lost on restart). Now every question and answer, the conversation history digest, verification drafts and claim ledger quotes go to **Cloud Logging** as structured JSON, retained by log policy and central sinks | The biggest change in data handling. It is exactly what turns an accidental pasted prospect name into stored data. Also the likeliest first question from InfoSec | Re-validation. Mitigation work in Phase 1 (scrubber, minimisation, retention decision) |
| **Business Assistance: Hubi now drafts customer-facing artifacts** (pitches, emails, talk tracks), not only answers. Finding #005 (claim fidelity) is open and release-blocking for wider rollout | A change in what the system does with its output: content risk and AI-output labelling (`§5.3`), not infrastructure risk | Re-validation of intended use; AI-draft label and sign-off |
| **More model calls carrying user text**: a second call to revise drafts, a claim-ledger in the prompt, and a query-expansion call that sends the user's question to the model | Same provider and identity, but more calls and more tokens of user text per turn | Mention in the delta; no new vendor |
| **Browser-carried conversation state**: the browser sends prior turns and context on every request, validated and capped server-side | Changes where conversation state lives (client, not instance memory); trust boundary is unchanged because the same user supplies it | Document |
| **New HTTP surface**: `/api/health`, 429 rate-limit responses keyed in memory on the IAP user header; feedback tags and free-text comments in `/api/feedback` | Small. The health endpoint exposes only commit and revision. The limiter keeps the user header in memory only and logs just the scope. The free-text feedback comment is a further place for accidental PII | Document |
| **Registry-driven governance**: AI Eligibility and restrictions come from a compiled snapshot of the Content Registry (internal IDs, eligibility, region, risk flags; no titles, no personal data) | Strengthens the control the earlier review saw; restrictions are now shown to users | Document as an improvement |
| **Deployment path**: a deploy script and CI exist, but production deploys still run from a developer machine; the repository is on a personal GitHub account | Not a data issue; the standard prohibits unvalidated manual production deploys | Pipeline and organisation repository (section 5) |
| **Corpus**: the Content Repository and the AI Eligibility picture can have changed since the review (it includes unregistered PMM files with ROI figures that have no registry record) | I cannot see what content was in scope at approval | Compare with the approval's content scope; register the unregistered files |

**Unchanged:** model and provider, identity and secrets model, ingress and authentication posture, content source and read-only access, no write access to other systems.

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
1. Send me the **InfoSec approval artifact** (ticket or email, date, reviewed scope, conditions). I will redo the section 3 diff against what was actually reviewed.
2. Confirm that Fabio Lima's role is an **LT member** for the Accountable role (or name the right one).
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
- **LT eligibility of the Accountable** is unverified and gates the RASCI and the Catalog row.
- **Region:** the production network is `us-east4`; Vertex AI model availability and latency there are unverified.
- **Ownership concentration:** product, engineering and the repository sit with one person today. The standard's "no single-person dependency" expectation needs a team behind the name.
- **Ambiguities in the standard itself** (raised by the compliance plugin): the training course names, the load balancer and pipeline specifics, "where applicable" for backup, and the definition of LT.

## 8. Cost and effort, honestly

Phase 1 is a few engineering days on top of what exists (the resilience, governance, logging and deploy foundations are the same controls the standard asks for). Phases 0 and 2 are calendar time on other teams: durations are set by intake queues and approvals that this repository cannot shorten. A reasonable planning assumption is weeks, not days, from intake to go-live. That estimate is mine, not Platform Engineering's. The existing InfoSec approval should shorten InfoSec's step; it does not remove it.
