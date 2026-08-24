# Logging and Analysis Foundation

**Status: design proposal, not yet implemented.** This document exists so the interaction log captures the right foundation from V0 onward, even though no analysis, export, or dashboard is being built now. Nothing in this document should be implemented until it's reviewed.

## What is already captured (current schema, unversioned)

Two record types, both appended to `logs/interactions.jsonl`, correlated by `sessionId` and `interactionId`:

```
interaction: { type, timestamp, sessionId, interactionId, question, response, sources[], turnKind, latencyMs, ok }
feedback:    { type, timestamp, sessionId, interactionId, helpful, comment? }
```

No personal data beyond a random `sessionId`. No schema version field. No session-level context of any kind. No retrieval scores/ranks — only the final rendered sources. No language signal. No applicability signal (directly relevant now, given Findings #001/#002).

## What is missing, relative to the future analysis needs listed

| Future need | Current gap |
|---|---|
| Frequent Revenue questions | Present (question text is captured) — no gap |
| Missing documentation | Present via `ok`/`turnKind`, but no structured "why" beyond that |
| Training needs, process confusion | No session-level role/team context to segment by |
| Regional/segment-specific knowledge gaps | **No region/segment/tier context anywhere — the exact gap Findings #001/#002 surfaced** |
| Retrieval, reasoning, applicability failures | No retrieval scores, no applicability flag, no language signal |
| Future personalized recommendations | No session-level context to personalize against, and rightly no permanent profile yet |
| Schema evolution over time | No `schemaVersion` — future changes would be ambiguous against historical data |
| Manual curation of findings | No event type for a reviewer to annotate a specific interaction after the fact |

## Proposed `schemaVersion` strategy

Every record gets a top-level `schemaVersion` field going forward. Retroactively, today's shipped shape is **version 1** (implicit — old lines have no field and are read as v1 by convention). The next iteration is **version 2**. Rule: only add fields, never rename or remove one; any reader treats a missing `schemaVersion` as `1` and unknown/absent new fields as `null`. This is the standard low-risk way to evolve an append-only log without migrations or breaking historical data.

## Session-level context — new record type, once per test session

A lightweight, explicitly **not-a-profile** context captured once at the start of a browser session (a short intake step before the first question, or attached to the "New session" action):

```
{
  type: "session_context",
  schemaVersion: 2,
  timestamp,
  sessionId,
  sessionType: "internal_team" | "moderated_rep_test" | "self_test",
  roleOrTeam: string | null,
  region: string | null,        // same canonical vocabulary as document metadata (see the Finding #002 implementation plan)
  segment: string | null,
  clientTier: string | null,
  contextSource: "session_setup" | "IAM" | "manually_reviewed"
}
```

For V0, `contextSource` is always `"session_setup"` — someone typed it in at the start of the session. Nothing here is a permanent identity; it lives only in that session's log entry, joined by the same `sessionId` already used for interactions and feedback. No new correlation mechanism needed.

## Retrieval and applicability evidence — extending the `interaction` record

```
{
  ...existing fields,
  schemaVersion: 2,
  retrievalCandidates: [{ documentId, chunkId, score, region, audience }, ...],  // top-K, not just what got rendered
  queryLanguageGuess: string | null,     // cheap heuristic; null if not implemented yet
  applicabilityFlag: "global" | "region_matched" | "region_unmatched_asked" | "region_unmatched_generalized" | null
}
```

`applicabilityFlag` is the most immediately valuable addition: it's a structured way to count exactly the failure mode Finding #002 confirmed live (`region_unmatched_generalized`) — without needing a dashboard, a reviewer can `grep` the log for that value the moment testing starts.

## Separating interaction, feedback, and manual-review events

Keep the existing `type` discriminator (`interaction` / `feedback`) and add a third:

```
{
  type: "manual_review",
  schemaVersion: 2,
  timestamp,
  sessionId,
  interactionId,
  reviewer: string | null,      // free text if the reviewer chooses to identify themself; never required
  findingRef: string | null,    // e.g. "validation-findings.md#002" for traceability
  assessment: string,
  contextSource: "manually_reviewed"
}
```

This lets an engineer or Product reviewer annotate a specific interaction after the fact (e.g. "this one is a Finding #002-type regional mismatch") without ever mutating the original immutable `interaction` record — the log stays append-only and the original record stays untouched.

## Future IAM compatibility

The `contextSource` enum (`session_setup` | `IAM` | `manually_reviewed`) exists specifically so a future version can populate `session_context` automatically from an authoritative corporate source (region/team/segment already known via IAM or HR systems) without changing the record shape — only `contextSource` flips to `"IAM"` and the values are populated by that source instead of a form. No schema break, no migration, just a new population path.

## Privacy and retention

- No name, email, IP, or browser fingerprint — true today, stays true. `sessionId` remains a random UUID.
- `session_context` fields are self-reported and coarse-grained (team/region-level), explicitly not a personal profile.
- **Open question, not decided here:** how long should local test logs be retained once a testing phase concludes — kept for longitudinal analysis, or archived/deleted on a schedule? This is a retention-policy call, not an engineering one; flagging it rather than deciding it.

## Backward compatibility

Purely additive. Old v1 `interaction`/`feedback` lines remain valid and readable forever; a missing `schemaVersion` is read as `1`. No existing field is ever renamed or removed. New fields default to `null`/absent when not yet populated, so old and new records can be read by the same tooling without branching logic beyond "is this field present."

## Minimum fields before internal and moderated rep testing

To be useful *during* the upcoming testing phase (not just for later deep analysis), the minimum viable additions are:

1. **`schemaVersion`** on every record — foundational, near-zero cost, prevents future ambiguity.
2. **`session_context`** record type + a minimal intake step (`sessionType`, `region`, `roleOrTeam` at minimum; `segment`/`clientTier` can be left null when not relevant).
3. **`applicabilityFlag`** on `interaction` records — directly supports spot-checking the exact risk Finding #002 confirmed, during testing itself, without replaying every conversation by hand.

`retrievalCandidates` and `queryLanguageGuess` are valuable for later deep analysis but are not required to catch problems during the upcoming test phase — reasonable to treat as a fast-follow rather than a blocker.

## Export, not a dashboard

The raw JSONL stays the immutable source of truth, always. A separate, simple script (not built yet) can flatten JSONL into a CSV for manual review in a spreadsheet, once there's enough real data to be worth looking at. No analytics platform or dashboard is proposed at this stage.
