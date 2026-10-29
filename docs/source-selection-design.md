# Source selection: freshness, authority, intent and audience

Decided 2026-10-29. Step 1 (access-level policy and registry metadata) is built; steps 2 to 4 are designed and approved but not built.

Hubi's corpus mixes trainings, playbooks, wiki pages, coaching sessions, decks and newsletters. Newsletters often hold the most recent operational updates while trainings and playbooks lag; a newsletter can also merely announce a training without containing its steps. Source selection therefore looks at **what kind of source it is, how recent it is, and what the user is asking**. It never penalises a source for being a newsletter.

## Source facts (built)

The governance snapshot (`lib/governance/registrySnapshot.ts`, generated from `config/governance/registry-export.csv`) now carries four more registry columns, and every served chunk carries them in `chunk.governance`:

| Field | Registry column | Use |
|---|---|---|
| `contentType` | Content Type | Training, Wiki Page, Newsletter, Coaching Session, Deck, Challenge |
| `collection` | Collection | A more reliable family than the type: two "Trending This Week" pages are typed Wiki Page |
| `accessLevel` | Access Level | The V1 access policy below |
| `sourceModified` | Source Platform Modified Date | Freshness fallback. Stored raw (day/month/year, 2- or 4-digit year, as the sheet writes it); parse only when unambiguous |

Freshness uses, in order: the date inside the document (70 of the 74 deployed documents have creation and last-updated dates in the file, in two formats), then `sourceModified`, then a date in the title. The four unregistered files (Slide Library, Pricing Playbook, Rules of Engagement, Revenue Organization 2025) have none of these, so they get no preference either way until Content registers them.

## 1. Access-level policy (built)

**Managers-only content cannot be enforced safely in V1**, so it is excluded, by policy and not by deleting files:
- Hubi sees an IAP email and nothing about role. Checking manager status means reading Workspace group membership, a new integration with personal data and an InfoSec re-score trigger (c). A self-declared "I'm a manager" is one click and unverifiable.
- `PILOT_GOVERNANCE_POLICY.servedAccessLevels` lists the levels Hubi serves: `Revenue – All` and `Revenue – Specific Function`. Any other level, or a blank one, is excluded with the reason "Access Level: ... (not served in V1: Hubi cannot verify who is asking)". Levels compare ignoring case, spacing and dash type.
- *Specific Function* content stays served: those labels are audience hints, handled by the audience notice, not restrictions.
- On the deployed corpus this removes exactly two documents: RKC-000001 "MANAGERS ONLY: League of Leaders" (47 chunks) and RKC-000017 "Managers huddle" (30 chunks). The registry is authoritative: RKC-000017's in-file audience lists Sales, Sales Dev and CS, but the registry says Leaders Only.
- The bucket is untouched and the change is reversible: widen the list, or set it undefined, when identity-aware access is approved. It appears in the governance report like any other exclusion.

## 2. Conflict handling (approved rule, not built)

The model is given the facts and applies this rule; code does the labelling and the notice, because a claim-level conflict is a judgment no deterministic check makes reliably.

- Each source header in the prompt gains `Type` and `Updated` (for example `Newsletter, updated 14 Jul 2026`).
- A notice appears only when the sources mix an update-type source with a process-type source, or cover the same topic from different dates. The rule it states:
  1. **If sources agree, answer normally.**
  2. **Do not prefer a source just because it is newer.** An official process source is not overridden by a newer source that merely mentions the topic.
  3. **If the newer source explicitly updates, replaces, overrides or supersedes the older guidance, prefer the newer information and say the guidance changed**, citing both.
  4. **If two relevant sources materially conflict and nothing signals supersession, flag the discrepancy and cite both; do not pick one as authoritative.**
  5. **A source that only announces a training or an update, without the underlying details, does not substitute for the source that contains the steps.**
- Measured with synthetic conflict cases through the live model (supersession stated, conflict with no signal, agreement, announcement-only) before it ships.

## 3. Intent-aware reserved slots (approved, not built)

No rescoring and no penalty. A deterministic lexicon classifies the question: **process** ("how do I", "steps", "process"), **recency** ("what changed", "new", "latest", "this week"), or unspecified (nothing changes).
- **Process intent:** ensure a process-type source (Training, Wiki Page, Coaching Session, a playbook) is represented in the sources the model sees. If none is among them but one scores at least half the best chunk within the 15 retrieved, add it. Same shape as the region pass.
- **Recency intent:** ensure an update-type source (Newsletter or the "Trending This Week" collection) is represented, newest first.
- A newsletter that announces a training can therefore no longer crowd the training out of a how-to answer, and a "what changed" question always sees the updates.

## Order and status

1. Access-level policy and the four registry columns: **done** (this commit).
2. Type and date labels on sources, logged for pilot analysis: **done**. Each source header carries `Type: <type> (<collection>) | Updated: <date>` (nothing for unregistered files), and each logged source records `contentType`, `collection`, `updated` and `updatedBasis`. On the deployed corpus all 39 registered served documents have an in-file date (the registry date was never needed); the 4 unregistered files stay unlabelled. Dates in titles are not used: no title in the corpus carries one.
3. The conflict notice with the synthetic evals.
4. The intent slots, measured on the production corpus (`scripts/fetch-prod-corpus.ts`).
