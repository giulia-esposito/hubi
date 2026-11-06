# Pilot operations (decisions and routines), from 2026-11-06

## Access

- Pilot access is the IAP role `roles/iap.httpsResourceAccessor` on the `hubi-pilot` Cloud Run service. On 2026-11-06 the Product Owner's team (17 people from Revenue Excellence and Tools) was added by email, so the policy holds those 17, the Product Owner and Marina Michel. Read the current list with `gcloud iap web get-iam-policy --resource-type=cloud-run --service=hubi-pilot --region=us-central1 --project=wh-revenue-sandbox`.
- Next wave (Sales US, Sales BR, CS UK) is added the same way once the Product Owner shares the list. A Google Group would be easier to manage, but the owner cannot create groups; it is part of the IT request.
- Access is only as reachable as the internal ingress: a tester on a network that cannot reach the service needs the corporate network or VPN. Confirm with one tester per country before announcing.

## Decisions (Product Owner, 2026-11-05 and 2026-11-06)

| Decision | Detail |
|---|---|
| Alerting | Not blocking the pilot. Alert policies wait for the Monitoring Editor role (Jira batch). Until then the pilot is checked by hand and by the weekly report. |
| Log retention | Keep the logs for the pilot. |
| Interface | Web app only for the pilot, as a normal page (no install, because of download restrictions on corporate computers). Google Chat is the final channel and is planned after the pilot (Pub/Sub path, thread store, InfoSec re-score). An HTTP endpoint is not an option. A side-panel browser extension is a possible later option; it would search Hubi's knowledge base only and never read the page. |
| Platform requests | Ask in the GCP Listening space first; open the single Jira only if pointed there. |
| Instructions for testers | A one-page guide or short video, produced only when everything is ready. |
| Front end | Layout is drafted before code: example questions as buttons, a visible "getting ready" state, grouped and collapsed sources with clean titles (metadata only in logs), feedback that is readable and has an optional written part, favicon and page title, and the company's branding. Branding source to be provided. |

## Feedback and the weekly report

- Testers' feedback is logged (`type: feedback`) with the turn's `interactionId`. The tester's identity is not logged (`HUBI_LOG_ACTOR` is off).
- `scripts/feedback-report.ts` reads Cloud Logging with Application Default Credentials (no keys), joins feedback to its question, answer and sources, and writes to `evals-out/feedback/` (git-ignored): a weekly report in Markdown, the rows for the review Sheet, and a list of questions Hubi could not answer (the content gap list for Content).

  ```bash
  node --experimental-strip-types scripts/feedback-report.ts --days 7
  ```

- The review Sheet is "Hubi pilot feedback" in the Product Owner's Drive. Each row has Owner, Status and Notes columns for triage.

## Adding content before the governed sync exists

Approved by the Product Owner on 2026-11-06 as a one-time, labelled bootstrap (it does not change the Drive-is-the-source decision):

1. Content registers each document in the registry (Eligible, with its Content ID).
2. Engineering exports it from Drive using the owner's access, and produces a report of what would change.
3. The Product Owner approves; only then is the bucket updated. Running instances read the corpus at start, so a new revision (or restart) is needed afterwards.
4. Each uploaded file's Drive ID and export date are recorded, so the governed sync can replace the manual copy.

Scope agreed: all playbooks, plus selected PMM decks.

How it is run (first batch, 2026-11-06):

- The Product Owner downloads the files from Drive into `content-incoming/` (git-ignored) and registers each in the registry.
- `config/content-bootstrap/<date>-manifest.json` maps each file to its registry Content ID, lists the older copies it replaces, and lists what was not staged and why. It is the record of what was loaded and from where.
- `node --experimental-strip-types scripts/dry-run-bootstrap.ts` builds the corpus the bucket would hold (hard links in the git-ignored `content-staging/`), ingests it through the real pipeline and the registry gate, and reports per document: chunks, region, link source, caveat, failures, exclusions. It uploads and deletes nothing.
- An older unregistered copy of a document that now has a registry row (for example `06.2025_Pricing_Rev Strategy Playbook.docx`) must be removed from the bucket in the same change, or it would be served without the registry's caveat.
- Registry changes reach Hubi through `config/governance/registry-export.csv` and `npm run registry:sync`; review the snapshot diff before committing.

What the registry now supplies when a document does not say it itself: the citation link (Original Source URL; WorkRamp admin links and search redirects are never shown) and the region (only when the document has no region of its own and the registry value is in the region map). An "Eligible with Restrictions" document flagged "Outdated Content" with no note gets the caveat "This source is marked as possibly outdated; confirm before sharing with a client." (decision 2026-11-06). Access Levels other than "Revenue – All" and "Revenue – Specific Function" are still not served.

Formats: `.docx`, `.pptx` and `.md` are read. PDF and Excel are not (the four registry spreadsheets are 30 to 40 sheets of price grids each; a text dump would invite wrong prices, so they wait for a decision). A Word file without the house template is titled by its file name, because its first heading is a section heading.

The deployed service now reads the bucket one file at a time (download, parse, delete) instead of keeping the whole repository in `/tmp`, which on Cloud Run is memory. The corpus after this batch is about 1.3 GB, mostly slide-library images, and would not fit in the 2 GiB container otherwise.

## Known behavior: names that are not in the knowledge (2026-11-06)

A tester asked how to position "extra check-ins". No document mentions that offer, but retrieval matched "check-ins" and Hubi answered about International Check-ins, a different add-on, as if they were the same. Two changes address it (lib/runtime/namedTerms.ts and the "Named things must match" rule in the system prompt): the prompt gets a notice listing wording from the question that the retrieved sources never use, so the model says the knowledge does not cover that item instead of substituting a similarly named one.

Measured with `scripts/eval-named-terms.ts` on the deployed corpus (5 runs per scenario): absent names kept apart in 17 of 20 runs (before: about 1 in 3 for the reported question), present names answered 15 of 15. The existing context-asking eval showed no drop. About 1 run in 6 can still equate the two, so the weekly feedback report should be read for this pattern. A stricter wording kept names apart in 18 of 20 runs but made Hubi say "not covered" instead of asking which segment applies, so it was not adopted.
