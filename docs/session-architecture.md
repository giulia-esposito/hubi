# Conversation state: decision record

**Status:** browser-carried history is the pilot mechanism and a deliberate transport, not the production end state. This records what it costs, what protects it today, and what would make us move to server-side persistence.

## Current design (commit `ab1c06c`, hardened afterwards)

The browser holds the conversation and sends, with every request: the prior turns (`history`), the previous answer's `planningMode`, and a `pinned` context (the region and country in force). The server rebuilds the session from the request (`lib/runtime/requestSession.ts`), so any Cloud Run instance can serve any turn and nothing is shared between instances. A request with no `history` falls back to instance memory (older clients).

## Protections in place

| Risk | Protection |
|---|---|
| Silent context loss when the window is full | The server keeps at most 24 turns, 8,000 characters per turn and 48,000 in total. When it drops or clips anything, the answer carries a visible notice ("Earlier messages ... were left out of this answer's context") and the log records `droppedOldest` and `truncatedTurns`. |
| A region stated early falls out of the window | The region and country in force are pinned: the server returns them with every answer and the client sends them back. A region named in a later message always wins; otherwise the pinned one applies (`regionSource` in the log says which). The failure mode without pinning was safe (Hubi asks again), but it was a regression of a context the user had already given. |
| Cannot reconstruct what context a bad answer saw | Every `interaction` entry records `continuity.history`: turn count, size, a SHA-256 digest (first 16 hex characters) of the exact history used, and the last two turns (trimmed). Two reports with the same digest saw the same context. |
| Forged history | Validated (roles, types, size) and capped; pinned values are checked against the approved region vocabulary. History is untrusted input like the question: it can change only the context of the conversation its sender is having, and it cannot affect eligibility or applicability, which are decided from retrieved chunks and detected regions. |
| Testers hitting a lost conversation | Feedback tag "It forgot what we discussed" (`lost-context`). |

Not done, deliberately: signing history (HMAC) so tampering is detectable. It becomes worth doing if tamper-evidence is required before server-side storage exists.

## Triggers for moving to server-side persistence

Move when **any one** of these is true; the first four can be measured from telemetry.

1. **Truncation is routine.** More than about 5% of turns carry `continuity.history.droppedOldest > 0`, or median conversation length approaches the 24-turn cap.
2. **Lost-context reports.** More than a handful of `lost-context` feedback entries in a pilot week, or any not explained by a truncation notice.
3. **A second client surface** (Google extension, Slack, API). Each would otherwise have to implement the history-carrying contract.
4. **Payload or abuse pressure.** Request bodies routinely near the 48 KB history cap, or any evidence of a client replaying maximal history to inflate cost.
5. **A replay or audit requirement** that the digest plus last two turns cannot meet (for example reproducing exactly what the model saw).
6. **Resume across reloads or devices.**
7. **Structured conversation state** beyond region and country (a draft under revision, pinned fact sets, long-running tasks).
8. **Retention, legal hold or compliance** rules on conversation data, or shared and handed-off conversations.

Queries (Logs Explorer):

```
jsonPayload.event="interaction" AND jsonPayload.continuity.history.droppedOldest>0
jsonPayload.event="feedback" AND jsonPayload.tags="lost-context"
jsonPayload.event="interaction" AND jsonPayload.applicability.regionSource="pinned"
```

## Target when a trigger fires

A conversation store keyed by conversation id and the IAP identity (Firestore is the lowest-operations GCP-native fit), with a TTL, server-side compaction (rolling summary plus pinned context), ownership checks on every read, and a client that sends only the id and the new message. The current history path can stay as a fallback. Token cost is the same either way (the history must be in the prompt wherever it is stored), and storage latency (tens of milliseconds) is small next to a 3-20 second model call, so the decision is driven by integrity, features and clients, not by cost or latency.
