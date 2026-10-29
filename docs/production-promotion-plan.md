# Path to Corporate Production (ISSTD28): readiness picture and promotion plan

Status: plan only, 2026-10-29. Nothing was deployed, requested or changed in GCP. This maps Hubi against ISSTD28 (GCP Corporate Production Environment Standard, v1.0) using the `wh-gcp-security` canonical copy (`canonical/ISSTD28-canonical.md`). Section references like `§5.1` are the standard's. Statements marked **plugin reading** are the compliance plugin's interpretation, not standard text. Hubi's own facts come from this repository; anything I could not verify is marked `[confirm]`.

## 1. What Hubi is, in the standard's terms

- **Classification: Corporate Production.** Hubi is an internal tool used by Revenue teams and does not deliver the Wellhub platform to clients (`§4`, `§5.1`). The Project Owner proposes the classification; InfoSec and the LT confirm it, and Legal confirms it too if personal or regulated data is processed.
- **Route: promotion, not provisioning.** A Sandbox project is never by itself eligible for production traffic; the solution is rebuilt or hardened, and the Sandbox attestation does not carry over (`§5.1`). The hosting project would be `wh-revenue-prd-corp` (registry: ACTIVE, staging pair `wh-revenue-stg-corp`, access group `revenue-corporate-production`, region `us-east4`, shared VPC host `networking-500210`).
- **Deployment model:** Cloud Run service (`the standard`, `§5.5`), AI agent: yes (drives the agent-specific requirements: rate limits, circuit breakers, decision-trace logging).
- **Not Platform Production.** If anyone proposes exposing Hubi to clients, this standard no longer applies and the path changes entirely.

## 2. Readiness against the seven promotion criteria (`§5.1`)

All seven must be evidenced. The Project Owner assembles and attests; the approval chain decides. A Project Owner cannot self-approve.

| | Criterion | State | Who closes it |
|---|---|---|---|
| (a) | Classification confirmed (InfoSec + LT, Legal if personal data) | **Missing.** Needs the data answer in section 4 first | Owner proposes; InfoSec, LT, Legal confirm |
| (b) | Unified approvals: LT, InfoSec, Infrastructure & Data (+ Legal, + CorpTech only if its support is requested) | **Missing, by design** | Other people only |
| (c) | RASCI with a named Responsible and an Accountable **LT** member | **Missing.** No named G6+ Project Owner or LT Accountable yet (section 4) | Owner drafts; Accountable must agree ("agreed, never dictated") |
| (d) | Catalog entry: accountable owner, responsible lead, direct contact channel | **Missing.** The Catalog row for `wh-revenue-prd-corp` is empty | Owner writes the row |
| (e) | Production readiness: source control, validated deployment, availability monitoring | **Partly.** See 2.1 | Engineering + Platform Engineering |
| (f) | Backup, RPO/RTO, recovery configured where applicable, or an approved exception | **Closable by justification.** Hubi holds no persistent state of its own (2.2) | Owner writes the justification |
| (g) | Data classified under ISSTD06 (+ DPIA and Legal if customer data or sensitive PII) | **Missing.** Open question in section 4 | Owner classifies; Legal decides on DPIA |

### 2.1 Readiness prerequisites (criterion e)

| Prerequisite | Today | Gap |
|---|---|---|
| Source control | Git, but on a personal GitHub account (`giulia-esposito/hubi`) | Strongly recommended, not mandatory, if documented with a named owner. Move to the Wellhub GitHub organisation before promotion: a personal repository cannot be the system of record for a production tool |
| Deployment with security validation | `scripts/deploy.ts` runs from a developer machine, with rollback and a config diff; CI runs tests only | **Manual or ad hoc production deployment without documented security validation is prohibited.** Needs the standard CI/CD pipeline (recommended) or a documented equivalent. The pipeline identity, not a person, holds `actAs` on the runtime service account. The pipeline's name and identity are not in the canonical registry: `[confirm]` with Platform Engineering. The deploy script's snapshot-and-diff logic is worth keeping as a post-deploy verification step |
| Availability monitoring | `/api/health` endpoint exists | Needs an uptime check and alert routing into the company monitoring stack (not named in the canonical registry, `[confirm]`). A go-live prerequisite |

### 2.2 Backup and DR (criterion f)

Hubi has no database and no user store. State is: the Content Repository copy in GCS (reproducible from the registry and source documents), the governance registry snapshot (in git), and logs (Cloud Logging). **Plugin reading:** "where applicable" means the workload holds persistent state or has a recovery need; a workload that does not is recorded `not-applicable` with the owner's written justification, which the approval chain sees. The justification to write: stateless service, content re-importable from source, recovery is redeploying a previous revision (already scripted) and re-syncing the bucket. Add object versioning on the content bucket and state an RTO. If anyone disagrees that this is "not applicable", the route is the Exception Request workflow (`§3`), not a decision recorded by the owner.

## 3. The hardening delta: Hubi as it is versus what production needs

| Area (standard) | Hubi today | Work |
|---|---|---|
| Invocation and ingress (`§5.5`) | Sandbox: internal ingress + IAP, authenticated invocation | Production is internal ingress through the **corporate load balancer and Zscaler**, authenticated invocation, never `allUsers`. How an owner publishes an internal service behind the corporate load balancer is not documented in the canonical registry: `[confirm]` with Platform Engineering. IAP may or may not be the sanctioned authentication there |
| Runtime identity, secrets (`§5.4`) | Cloud Run service identity via ADC. No keys, no secrets (org rule) | Dedicated runtime service account in the production project; no human `actAs`. Already the right shape |
| Egress (`§5.5`) | Calls Vertex AI and GCS | Egress only through the corporate secure web proxy on an explicit allowlist, via the shared VPC. Direct VPC egress through `prd-corp-workload-subnet`. Confirm Vertex AI (Google APIs) is reachable on that path and that the Gemini model is available in `us-east4` (the pilot runs in `us-central1`, and `gemini-2.5-pro` is already known to be unavailable there) |
| Labels (`§5.4`) | Sandbox-managed | Set `environment`, `team`, `cost-center`, `data-classification` on the service and resources. Cost center is unknown: `[confirm]` |
| Application logging (`§5.6`) | Structured JSON to Cloud Logging: UTC timestamp, severity, correlation ids (`sessionId`, `interactionId`), request metadata, retrieval and verification detail | **Add the acting user identifier and source IP** (mandatory fields; available from the IAP/proxy identity headers). **Review what is logged in plaintext:** questions and answers are stored in full, which the standard forbids if they can contain sensitive PII (section 4). Central audit retention is 365 days (ISSTD14), owned by the platform, not by Hubi |
| AI agent logging (`§5.6`) | Logs the question, retrieved source ids, answer, verification and attribution outcome, expansion terms, engine attempts | The standard asks for tools and external APIs called, their parameters, and "model prompts, reasoning steps, selected execution paths". The model prompt itself is not logged today (it contains retrieved content). Decide what trace is sufficient and where it is kept, balancing against the plaintext rule above |
| Agent limits and circuit breakers (`§5.2`) | Per-user and per-instance request caps, concurrency cap, bounded retries (`docs/provider-resilience.md`) | **Circuit breaker is not built** (stop calling the provider after repeated failures; pause on anomalous loops). Small, in scope for engineering |
| Integrations (`§5.3`) | Vertex AI (Gemini), GCS | Every integration must be an approved connector, an ISSTD26-built MCP, or InfoSec + PE-approved and recorded in the **Authorized AI Tools and Connectors Registry**. Not in the registry means prohibited. Planned sources (WorkRamp, Drive) each need their own entry and, if they write or cross systems, the system owner's documented approval. Confirm no Wellhub data is used for model training under the Vertex configuration |
| AI output (`§5.3`, `§5.10`) | Pitches and emails are generated for customer-facing use; sources are cited | AI-made artifacts used in a corporate decision are labelled (tool + date) and carry a documented human sign-off. Product decision: how Hubi marks drafts and where sign-off is recorded. Finding #005 (claim fidelity) is release-blocking for wider rollout independent of this standard |
| Data (`§5.9`) | Internal knowledge content, user questions | See section 4 |
| Budget (`§5.8`) | Sandbox budget | Standard FinOps process for the owning cost center; the Accountable LT member owns it. Alerts at 50, 80, 100 percent |
| Lifecycle (`§5.10`) | Sandbox 60-day inactivity assumption | No inactivity decommission; decommissioning needs a business decision and owner sign-off |
| Human access (`§5.4`) | Developer has write access in the Sandbox | Production defaults to Viewer; write is per-request and needs PE + InfoSec GRC approval; no human `actAs`, no human reads of secret values. Engineers will not be able to "just fix it" in production: everything goes through the pipeline |

## 4. Decisions and facts only people can supply (blocking)

1. **Project Owner (Responsible), job grade G6 or above, and an Accountable LT member.** The registry lists Marina Michel as the GCP Project Owner of `wh-revenue-prd-corp`, but we recorded earlier that she is no longer a dependency of Hubi, and nobody has named an Accountable LT member. The Project Owner carries 24x7, 365-day responsibility for Hubi and its outputs. Who is it, and who is the LT member?
2. **Who is on call.** "You build it, you run it": R and A are jointly responsible for incidents and for fixing agent-flagged findings within 2 business days; a severe finding can block the service without notice. CorpTech is not the default support. Hubi has no on-call arrangement today. A Support SLA is only strongly recommended, but the RASCI is not optional.
3. **Is any of the data customer data or sensitive PII?** Users type prospect and client details into Hubi (company names, size, industry, country, sometimes people), and the pilot stores those questions and answers. Whether that is "customer data" under `§5.9` is a Legal Privacy question, not an engineering one. If yes: a DPIA and Legal approval are required **before** processing starts and again at go-live, CMEK applies to data stores holding it, and DLP controls the flow to the language model. If no (internal data only): classification under ISSTD06 and no extra gate. Ask now, because the answer changes the scope of every other item.
4. **Is Corporate Production the right target at all for the next phase?** A Sandbox pilot with named testers needs no promotion. Promotion is justified when Hubi becomes something Revenue relies on daily. The plan below is cheap to start and expensive to finish; this is the moment to confirm the business wants the finish.
5. **Cost center, budget owner and the `data-classification` label value** (ISSTD06 levels: confidential, internal, public).

## 5. Plan

Phases are ordered by who can act. Items inside engineering's control start now and carry no approval risk.

**Phase 0: decisions and intake (Giulia, LT, Legal).** Answer section 4. Enter the standard prioritization process for promotion (this is the intake the standard calls "Standard Prioritization Process"). Ask Legal Privacy the data question. Name the owner, the Accountable LT member and the on-call group.

**Phase 1: engineering, no approvals needed (can start immediately).**
- Add the acting user identifier and source IP to application logs; decide and implement a plaintext policy for questions and answers (redaction, shorter retention, or logging only identifiers and hashes) once Legal has answered; log the decision trace the standard asks for.
- Circuit breaker for the provider and for anomalous request patterns.
- Mark generated artifacts as AI drafts with tool and date, plus a place to record human sign-off (Product decides the UX).
- Content bucket object versioning; an RTO statement.
- Keep `scripts/deploy.ts`'s protected-settings diff as a post-deploy verification step for the pipeline to run.
- Draft the documents the owner must sign: RASCI, backup not-applicable justification, Support SLA (lightweight), Catalog row, integration registry entries. Drafts only; the people named must agree to them.
- Move the repository to the Wellhub GitHub organisation.
- Run the bundled SAST review (`wh-infosec-sast-review`) on the codebase and fix confirmed findings. It is a plugin-added gate, not an ISSTD28 control, but it is the cheapest evidence of due diligence before InfoSec sees the code.

**Phase 2: platform and security (Platform Engineering, InfoSec, Infrastructure & Data).**
- Obtain: access to the standard CI/CD pipeline and its identity; the sanctioned way to publish behind the corporate load balancer and Zscaler; the monitoring stack and alert routing; the egress allowlist entries for Vertex AI and Cloud Storage; label values; the budget and FinOps registration.
- Registry entries for Vertex AI and GCS (and each future source) in the Authorized AI Tools and Connectors Registry.
- Training: everyone authorised to touch the production project completes AI Security and Secure SDLC (KnowBe4) and recertifies every 6 months; lapse means automated access revocation.
- Optionally request staging use of `wh-revenue-stg-corp`. It is governed as a Sandbox project unless it processes production data, in which case ISSTD28 applies to it in full: keep production data out of it.

**Phase 3: assurance.**
- Complete the workload manifest (`.wh-corp-production/workload.yaml`, drafted alongside this plan with every unknown marked `[confirm]`). Approvals are left `pending`; they are other people's decisions.
- Deploy through the pipeline into the production project, then run `wh-corp-prod-guardrail-check` against the real configuration. Expect `INCONCLUSIVE` for controls an owner with Viewer access cannot read (IAM policy, central sinks, budgets); that is the access model working, not a pass.
- Owner attestation (`wh-corp-prod-attest`): the owner types the acknowledgment in their own words and the evidence is assembled. This records evidence; it is not the promotion decision.
- The approval chain decides: LT, InfoSec, Infrastructure & Data, plus Legal if personal data, plus CorpTech only if its support was requested.

**Phase 4: go-live and steady state.** Hypercare with the named on-call; schedule `wh-corp-prod-drift-audit`; semi-annual access review (manager and PE); remediation inside 2 business days; re-attest after material change.

## 6. Risks worth naming

- **Finding #005 is the content risk, not an infrastructure one.** ISSTD28 asks users to validate AI output, but it does not make Hubi's customer-facing drafts safe. The claim guardrail is a pilot mitigation; the ledger runs observe-only by default. Wider rollout stays gated on it independent of this plan.
- **The plaintext logging default conflicts with the standard if prospect data counts as sensitive.** It is the most likely thing InfoSec will question first.
- **Region:** the production network is `us-east4`; Vertex AI model availability and latency there are unverified.
- **Ownership concentration:** today one person owns product, engineering and the repository. The standard's 24x7 and "no single-person dependency" (backup/DR documentation) expectations need a team behind the name.
- **Three open ambiguities in the standard itself** (raised with the standard owner by the compliance plugin): the training course names, the load balancer and pipeline specifics, and what "where applicable" means for backup.

## 7. Cost and effort, honestly

Phase 1 is a few engineering days of work on top of what already exists (the resilience, governance, logging, and deploy foundations are the same controls the standard asks for, which is why they were prioritised). Phases 0 and 2 are calendar time on other teams, not effort: their duration is set by intake queues and approvals that this repository cannot shorten. A reasonable planning assumption is weeks, not days, from intake to go-live. That estimate is mine, not Platform Engineering's.
