# DRAFT: delta note to InfoSec against ISSD-51294 (Hubi AI)

Draft for the product owner to edit and send. Not sent. Written in the owner's voice; bracketed items need a fact only the owner or the platform team has.

**To:** Guilherme Crucillo (InfoSec)
**Re:** ISSD-51294, Hubi AI, approved 2026-06-09 (CBRA 4, Low)

Hi Guilherme,

Thank you for the assessment. Hubi has moved from design to a working pilot, and we are preparing to promote it to Corporate Production under ISSTD28 (`wh-revenue-prd-corp`, Revenue only). I want to treat this as a delta against your approval, not a new request, so below is where we stand against its conditions and the five things that have moved. I would like you to tell us whether you can extend the existing approval or what you need re-reviewed.

## 1. Re-score triggers from your decision

None of the five is triggered today:
- (a) Confidential or client data in the knowledge base: the knowledge content is Internal-classified and governed by the Revenue Knowledge Center registry (AI Eligibility gate, restrictions shown to users). Not triggered.
- (b) MCP servers or tool calling: none. No tools, no sub-agents, no write access to any system.
- (c) WorkRamp or any system involving personal data: no integration; the content is a file export.
- (d) Persistent memory: the agent has none; every session starts empty. See 2.2 on conversation logs, which I would like you to rule on.
- (e) Beyond the Revenue organisation: no. Revenue only.

## 2. What has moved since the submission

**2.1 Model and provider.** The submission named Anthropic Claude as the primary LLM, with Gemini possible. The pilot runs **Gemini 2.5 Flash on Vertex AI inside Wellhub's own GCP project**, using the service identity (no API keys, no secrets). No Anthropic dependency and no third-party AI vendor. Your Permissions score rested on data flowing to an external LLM API; this keeps prompts inside Wellhub's cloud. Please confirm Gemini on Vertex is covered, and that no Wellhub data is used for model training in this configuration [confirm with the platform team].

**2.2 Logging and retention (the open item in the submission).** The submission left the storage architecture and retention to be defined with you. The pilot logs each interaction as structured JSON to Cloud Logging: the question, the answer, source ids, verification results and a digest of the conversation history. Users are told to ask about internal processes, and are not expected to enter personal data or client-confidential details, but free text can contain anything. What I propose, for your decision: (i) a visible notice in the UI not to enter personal data or confidential client information; (ii) scrubbing emails and phone numbers from logged text and shortening what is stored; (iii) a retention period that you set, with the central 365-day audit retention applying to audit logs, not to the question and answer text; (iv) logging the acting user and source IP as ISSTD28 requires. Please tell us the retention you want for question and answer text. Is conversation text in logs "persistent memory" for trigger (d)? We think not, but it is your call.

**2.3 Document creation.** The submission ticked research, summarisation, writing assistance and decision support, but not "Document creation and review". Hubi now also drafts pitches, intro emails and talk tracks for reps ("Business Assistance"). It still sends nothing and executes nothing; a person reviews every output (oversight level 1 as submitted). Sources are cited and a claim check removes unsupported figures. A known limit: the model can overstate a claim's scope or cause, which we track as an open finding, so drafts are treated as drafts. We are adding an "AI draft" label with tool and date. Does this extend the declared purposes, or does it need a new submission?

**2.4 Worst-case assessment.** The submission rated the worst case as minor rework for a small group. With customer-facing drafts, a more honest worst case is a misleading statement reaching a prospect before a rep catches it. We rate it level 3 (a meaningful problem for a team or process, fixable). Does that change the Impact score?

**2.5 User-entered data.** The data table in the submission listed knowledge sources only. User questions are an input we did not describe. They are free text about internal processes; we classify them Internal and treat logs as Confidential until the scrubbing in 2.2 is in place. If you or Legal read "client data" to include prospect business details typed by accident, tell us and we will involve Legal Privacy on the DPIA question.

**2.6 Conversation history in the browser.** So that a page reload does not lose context, the web app keeps the conversation (questions, answers, sources) in the browser's local storage on the user's own device for up to 24 hours after the last message. The server stores nothing new. Cleared by the "New conversation" button or on expiry. It is client-side persistence, which is longer than a browser session, so please tell us whether it stays within "per-session" memory for trigger (d).

## 3. The submission's open items: where they landed

| Open item | Now |
|---|---|
| API gateway / connectivity | Direct calls to Vertex AI from Cloud Run through the service identity, egress via the corporate VPC in production. **Does Vertex AI inside our own project count as an "external AI API" that must go through the TC3 Agent Gateway or Apigee?** |
| LLM provider DPA | No third-party provider: Vertex AI in the company's GCP project [confirm with Legal that the Google Cloud terms cover this] |
| Secrets / final architecture | No secrets or keys at all: Application Default Credentials. Cloud Run, Gemini on Vertex, GCS read-only content copy, web UI behind the corporate network (Google Chat not built) |
| Retention architecture | Open, see 2.2 |
| WorkRamp, Google Chat | Not built; either would be a new submission |

## 4. Questions

1. Your Impact Radius row shows a score of 1 (and the total of 4 uses it), but the rationale says "scored conservatively at 2". With 2 the total is 8 (Medium). Which is right?
2. Was there any condition besides the re-score trigger? The decision says the conditions "must be closed before production go-live" but lists only that one.
3. Gemini on Vertex, 2.1: covered?
4. The gateway question in section 3.
5. Retention for question and answer text, 2.2.
6. Can this approval be the starting point for the InfoSec step of the ISSTD28 promotion (LT, InfoSec and Infrastructure and Data), so the review is a delta and not a restart?

Attachments I can provide: the current architecture and data-flow description, the governance registry design, the telemetry schema, and the ISSTD28 readiness plan.

Thanks,
Giulia
