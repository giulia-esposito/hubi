# Drafts for the people named in the ISSTD28 plan to read, edit and agree

Drafts only. Nobody has agreed to any of this, and none of it has been submitted anywhere. ISSTD28 says a RASCI is "agreed, never dictated", so the named people must review and own each item. Bracketed items are facts only the owner or the platform team has.

## 1. RASCI (criterion c)

| | Who | What they are responsible for |
|---|---|---|
| **R** Project Owner | Marina Michel (G6+ asserted by the product owner) | Design, secure configuration, upkeep and operation of Hubi and its AI agent; incident resolution; backup/DR; remediating scanner findings. Types the `§6.5` acknowledgment |
| **A** Accountable (LT) | Fabio Lima (LT membership confirmed by InfoSec and the LT in the approval chain) | Budget, risk acceptance, policy compliance for the Revenue domain; accepts the out-of-hours coverage model in writing; escalates exceptions to the ELT |
| **R (day to day)** Product and operational owner | Giulia Esposito | Product decisions, content and governance, pilot and rollout, first contact for users, drives the Catalog and documentation. Escalates to the Project Owner |
| **S** Support | [named technical maintainer: a person or team that can operate the deployment pipeline, roll back and remediate findings] | Executes technical changes through the pipeline. **Not yet named** |
| **C** Consulted | InfoSec (guardrail enforcement, governance review; not design or operations); Legal Privacy (DPIA outcome); Revenue Strategy and Enablement leadership; Infrastructure and Data (approval chain) | |
| **I** Informed | Project Owner's manager, CorpIT Governance, ELT (cost and risk) | |

CorpTech: not requested. It would be added as C, and its approval to the chain, only if the LT asks for its support in writing.

## 2. Support SLA (recommended, lightweight; option b from the plan)

- **Hours of active support:** [business hours in the Revenue organisation's main timezones, to be stated].
- **Response targets by severity** [owner to confirm]: security or data-exposure incident, immediate and per ISSTD02 (report to InfoSec at once); service down, within [1 business hour]; degraded or wrong answers, [next business day]; feature requests, backlog.
- **Out of hours:** no staffed rota. The safe state is the kill switch below, which the Project Owner or the product owner may trigger at any time. The Accountable accepts this gap in writing. The standard states 24x7 operation as the Project Owner's responsibility, so this is a stated risk acceptance, not a waiver, and InfoSec should see it.
- **Escalation:** product owner, then Project Owner, then Accountable.
- **Findings:** standard-severity findings remediated within 2 business days; a severe finding may be auto-blocked by the platform's agents and is fixed, verified and unblocked by the technical maintainer.
- **Contact channel:** [a Revenue Strategy and Operations team channel or group mailbox].

## 3. Kill switch and rollback

The approval committed to "AI functionality can be disabled without impacting operational systems". Safe states, from least to most disruptive:
1. **Roll back** to the previous revision: `node --experimental-strip-types scripts/deploy.ts rollback --env <env>` (shows the target and changes nothing without `--confirm`). Details in `docs/deployment-runbook.md`. In production this runs through the deployment pipeline's identity, since no person holds standing write access.
2. **Disable the AI path** without removing the service: switch the provider off by configuration so the service returns its "currently unavailable" message. [done by the pipeline operator]
3. **Stop serving**: scale the service to zero instances or remove its route at the load balancer. Hubi holds no state, so nothing is lost.

Who may trigger: the Project Owner or the product owner, by asking the technical maintainer or the platform on-call [named contact]. Because production access is Viewer by default, none of these is a self-service console action for the owner. That is the main reason a named technical maintainer is needed.

## 4. Backup and DR justification for criterion (f)

The Project Owner states it in their own words. Draft for Marina Michel to rewrite: "Hubi is a stateless service. It stores no user accounts or business records. Its knowledge content is a read-only copy of the Revenue Knowledge Center, which remains the source of truth and can be re-imported at any time; its governance rules are versioned in source control; logs are held by Cloud Logging and the central audit sinks. Recovery is redeploying the previous revision, which is scripted and takes minutes, and re-syncing the content bucket. RPO: not applicable for the service; for the content copy, the last sync. RTO target: [4 business hours]. Because the workload holds no persistent state of its own, backup configuration is not applicable; we ask the approval chain to accept this under criterion (f)." If the chain disagrees, the route is an Exception Request, not a decision recorded by the owner.

Pending: object versioning on the content bucket is a GCP change (not made here, per the standing no-GCP-changes rule); it needs the platform team or an approved pipeline step.

## 5. Catalog row (criterion d: the three things the standard requires)

| Field | Draft |
|---|---|
| Project | `wh-revenue-prd-corp` |
| Accountable owner | Fabio Lima |
| Responsible lead | Marina Michel |
| Direct contact channel | [Revenue Strategy and Operations channel] |
| Other columns (tiers, uptime link, sign-offs) | The Catalog's own design, not standard text; fill as the Catalog's Read-me asks. Do not fill approval columns: they are other people's decisions |

## 6. Integrations for the Authorized AI Tools and Connectors Registry

| System | Path | Access | Note |
|---|---|---|---|
| Vertex AI (Gemini 2.5 Flash) | Alternative path with equivalent controls: authenticated invocation by service identity, least privilege, agent actions logged | Invoke | Inside the company GCP project, no API key; no Wellhub data used for model training [confirm] |
| Google Cloud Storage (content bucket) | Alternative path | Read | Read-only copy of the Revenue Knowledge Center |

No MCP servers, no tool calling, no write access: that is a re-score condition of the InfoSec approval.
