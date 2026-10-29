# Re-score watchlist for the Hubi InfoSec approval (ISSD-51294)

The approval (2026-06-09, CBRA 4 Low) covers "Internal-data RAG, no MCP servers, no write access, single agent, about 700 Revenue users", and says any of the five triggers below needs a **new assessment submission**. Anyone changing Hubi checks this list first, and it is updated whenever a change touches one of these areas.

| Trigger | What would cross it | Where to look | State |
|---|---|---|---|
| (a) Confidential or client data in the knowledge base | Ingesting client contracts, client lists, financial or HR content; content classified above Internal; CRM or Salesforce data | `lib/ingestion`, the Content Registry (`config/governance/registry-export.csv`), the GCS content bucket | Clear. Content is Internal; the registry marks everything "Client-shareable: No". Five PMM files have no registry record: register them with a classification |
| (b) MCP servers or tool calling | Any model call that can invoke a function or tool; agent frameworks; function-calling configs | `lib/runtime/reasoningEngine*`, any new SDK | Clear. The model only generates text |
| (c) WorkRamp or any system involving personal data | A connector or sync to WorkRamp, Salesforce, Drive, Gmail, Chat | `lib/ingestion/contentSource.ts` and anything new | Clear. A future automatic sync is a trigger |
| (d) Persistent memory | The agent reading anything from a previous session: stored profiles, vector memory of past chats, server-side session stores, using logs as context | `lib/runtime/sessionState.ts`, `requestSession.ts`, browser storage in `app/page.tsx` | Clear. Per-session only. **Judgment call:** logs hold conversation text but the agent never reads them. InfoSec to confirm in the delta note |
| (e) Beyond the Revenue organisation | Opening access to other functions, a public or customer-facing surface | IAP access list, the production access group | Clear. Revenue only |

## Phase 1 changes and their data-handling effect

Flag before any of these changes behaviour in production.

| Change | Effect on data handling | Default | Flag to InfoSec? |
|---|---|---|---|
| Scrub emails and phone-like numbers from logged text | **Reduces** what is stored | On (`HUBI_LOG_SCRUB=0` disables) | No, it narrows the approved handling; mention in the delta note |
| Log acting user and source IP | **Adds employee identifiers** to logs. Required by ISSTD28 `§5.6`, not in the approved design | **Off** (`HUBI_LOG_ACTOR=1` enables) | **Yes, before turning it on in production** |
| Provider circuit breaker | None on data; a short refusal when the provider is down | On | No |
| UI notice not to enter personal data; AI-draft label (tool and date) on Business Assistance answers | None on data; user-visible wording. Proposed copy is in `app/page.tsx` and is yours to edit | On | Product owner reviews the wording |
| Content bucket versioning | Retains older copies of content that is already Internal | Not done (a GCP change) | Mention |

Nothing in Phase 1 adds a tool, a connector, a data source, persistent agent memory or users outside Revenue.
